import mongoose, { Types, type ClientSession } from "mongoose";
import {
  Currency,
  CouponType,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
  UserType,
} from "@maria-matera/shared";
import { logger } from "../config/logger.js";
import { Customer } from "../models/Customer.js";
import {
  Order,
  type OrderAddressSnapshot,
  type OrderDocument,
  type OrderShipping,
} from "../models/Order.js";
import { StockReservation } from "../models/StockReservation.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { generateOrderNumber } from "../utils/orderNumber.js";
import * as cartService from "./cart.service.js";
import * as couponService from "./coupon.service.js";
import * as inventoryService from "./inventory.service.js";
import { notifyOwner } from "./notification/telegram.js";
import { dispatchPaidSideEffects } from "./notification/order.notifications.js";
import { getPaymentProvider } from "./payment/index.js";
import { recordAudit } from "./audit.service.js";

/**
 * Order lifecycle — the critical, money-and-inventory module of the checkout.
 *
 * `createOrder` runs entirely inside ONE Mongo transaction: server-side pricing
 * recompute, stock reservation, coupon redemption, order snapshot creation and
 * cart clearing either all commit or all roll back. Prices are NEVER trusted
 * from the client — they are recomputed from the live catalog via
 * `cartService.getPriced`. Owner-facing reads are always scoped by `customerId`
 * *in the query itself* (anti-IDOR), never a global lookup + app-level check.
 */

const MODULE = "order";

interface CreateOrderInput {
  idempotencyKey: string;
  shippingAddressId: string;
  billingAddressId: string;
  couponCode?: string;
  paymentProvider?: PaymentProvider;
  // Shipping-label contact, typed at checkout — merged into the shipping
  // address snapshot only (never the billing snapshot).
  recipientName?: string;
  phone?: string;
}

/**
 * Legal state machine. Forward-only through the fulfilment happy path, with
 * explicit cancel/refund branches. Terminal states (`cancelled`, `refunded`)
 * allow no further transition. This is the single source of truth every
 * transition helper validates against.
 *
 * ONE deliberate backward branch exists: `shipped → processing`, a fulfilment
 * *correction* for when a shipment must be undone (the carrier lost the package
 * before it moved, or an admin fat-fingered the guide) so the shipping data can
 * be cleared and re-entered. It is an explicit, approved exception — NOT a
 * general state-machine backdoor: no other backward transition exists, and in
 * particular `delivered` still reverts to nothing (only `refunded`).
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PendingPayment]: [OrderStatus.Paid, OrderStatus.Cancelled],
  [OrderStatus.Paid]: [OrderStatus.Processing, OrderStatus.Cancelled, OrderStatus.Refunded],
  [OrderStatus.Processing]: [OrderStatus.Shipped, OrderStatus.Cancelled, OrderStatus.Refunded],
  [OrderStatus.Shipped]: [OrderStatus.Delivered, OrderStatus.Refunded, OrderStatus.Processing],
  [OrderStatus.Delivered]: [OrderStatus.Refunded],
  [OrderStatus.Cancelled]: [],
  [OrderStatus.Refunded]: [],
};

const assertTransition = (from: OrderStatus, to: OrderStatus): void => {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new AppError(
      `Transición de estado no permitida: no se puede pasar de "${from}" a "${to}".`,
      409,
    );
  }
};

/** Copies an address subdocument's FIELDS by value (never a reference). */
const snapshotAddress = (address: {
  label: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  rfc?: string;
  cfdiUse?: string;
  taxRegime?: string;
}): OrderAddressSnapshot => ({
  label: address.label,
  line1: address.line1,
  city: address.city,
  state: address.state,
  zip: address.zip,
  country: address.country,
  ...(address.rfc ? { rfc: address.rfc } : {}),
  ...(address.cfdiUse ? { cfdiUse: address.cfdiUse } : {}),
  ...(address.taxRegime ? { taxRegime: address.taxRegime } : {}),
});

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/** The checkout result: the persisted order plus the client secret the payment
 *  SDK uses to confirm the PaymentIntent from the browser. */
interface CreateOrderResult {
  order: OrderDocument;
  clientSecret: string;
}

/**
 * Ensures the order has a payment intent and returns the client secret, ALWAYS
 * as a step OUTSIDE any Mongo transaction. Holding a DB transaction open across
 * this external network round-trip would pin locks/resources and risk a
 * transaction timeout — the anti-pattern this split deliberately avoids.
 *
 * - No `payment.ref` yet (fresh order, OR a prior attempt whose Mongo txn
 *   committed but crashed before the Stripe call landed): create the intent and
 *   persist the ref via a simple, separate update.
 * - Already has a `payment.ref` (idempotent retry of a fully-created order):
 *   retrieve the existing intent to hand its client secret back — never mint a
 *   second intent.
 *
 * The Stripe idempotency key is the order's own id (globally unique) rather than
 * the client-supplied `idempotencyKey`: the latter is unique only per-customer
 * (two different customers may legitimately reuse the same key), so sending it
 * to Stripe could collide two distinct orders' intents. `order.id` guarantees a
 * network retry for THIS order reuses the same intent with zero collision risk.
 */
const finalizePayment = async (order: OrderDocument): Promise<CreateOrderResult> => {
  const provider = getPaymentProvider(order.payment.provider);

  if (order.payment.ref) {
    const intent = await provider.retrievePaymentIntent(order.payment.ref);
    return { order, clientSecret: intent.clientSecret ?? "" };
  }

  const { ref, clientSecret } = await provider.createPaymentIntent({
    amountCents: order.totalCents,
    currency: order.currency,
    metadata: { orderId: order.id as string },
    idempotencyKey: order.id as string,
  });

  order.payment.ref = ref;
  await order.save();

  return { order, clientSecret };
};

const createOrder = async (
  customerId: string,
  input: CreateOrderInput,
): Promise<CreateOrderResult> => {
  // 1. Idempotency fast-path: a retry with the same key returns the existing
  //    order immediately, with ZERO order side effects re-run (no reservation,
  //    no coupon redemption). Payment is still finalized so a prior attempt that
  //    committed the order but never reached Stripe still gets its intent.
  const existing = await Order.findOne({ customerId, idempotencyKey: input.idempotencyKey });
  if (existing) {
    return finalizePayment(existing);
  }

  // Address snapshot validation (anti-IDOR: the addresses must belong to THIS
  // customer). Loading the customer by id scopes the lookup to the owner.
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Cliente no encontrado.", 404);
  }
  const shipping = customer.addresses.id(input.shippingAddressId);
  if (!shipping) {
    throw new AppError("La dirección de envío no existe o no te pertenece.", 404);
  }
  const billing = customer.addresses.id(input.billingAddressId);
  if (!billing) {
    throw new AppError("La dirección de facturación no existe o no te pertenece.", 404);
  }
  const shippingSnapshot = {
    ...snapshotAddress(shipping),
    ...(input.recipientName ? { recipientName: input.recipientName } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
  };
  const billingSnapshot = snapshotAddress(billing);

  // 2. Recompute pricing server-side (never trust client prices).
  const rawCart = await cartService.getOrCreate(customerId);
  if (rawCart.items.length === 0) {
    throw new AppError("Tu carrito está vacío.", 400);
  }
  const priced = await cartService.getPriced(customerId);

  // Gap #2: `getPriced` silently drops lines whose product/variant became
  // unpurchasable. Silently charging for a subset of the cart is a trust/
  // correctness failure at checkout — abort and tell the customer to review it.
  if (priced.items.length !== rawCart.items.length) {
    throw new AppError(
      "Algunos artículos de tu carrito ya no están disponibles. Revisa tu carrito antes de continuar.",
      409,
    );
  }

  const orderItems = priced.items.map((line) => ({
    productId: new Types.ObjectId(line.productId),
    variantId: new Types.ObjectId(line.variantId),
    sku: line.sku,
    name: line.name,
    qty: line.qty,
    unitPriceCents: line.unitPriceCents,
    // Cart DTO calls it `linePriceCents`; the immutable Order snapshot calls the
    // same value `lineSubtotalCents`. Explicit one-line rename.
    lineSubtotalCents: line.linePriceCents,
  }));
  const reserveItems = priced.items.map((line) => ({ variantId: line.variantId, qty: line.qty }));

  let created: OrderDocument | undefined;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Belt-and-suspenders re-check for a double-submit that slipped past the
      // fast-path. Note: under Mongo snapshot isolation two concurrent
      // transactions can't see each other's uncommitted insert, so the REAL
      // guard against a concurrent double-charge is the `{customerId,
      // idempotencyKey}` unique index (its E11000 is caught below); this read
      // only cheaply short-circuits an already-committed prior order.
      const dup = await Order.findOne({
        customerId,
        idempotencyKey: input.idempotencyKey,
      }).session(session);
      if (dup) {
        created = dup;
        return;
      }

      // 3. Reserve stock — participates in THIS transaction (before coupon
      //    redemption, so a stock failure never lets a coupon be redeemed).
      const reservation = await inventoryService.reserveStock(reserveItems, undefined, session);

      // 4. Apply coupon (if any), inside the same transaction.
      let discountCents: number | undefined;
      let couponCode: string | undefined;
      const shippingCostCents = priced.shippingCostCents;
      if (input.couponCode) {
        const redemption = await couponService.redeem(
          input.couponCode,
          customerId,
          session,
          customer.tier,
          priced.subtotalCents,
        );
        couponCode = redemption.coupon.code;
        if (redemption.coupon.type === CouponType.FreeShipping) {
          // Free shipping is modelled as a discount equal to the shipping cost,
          // keeping the invariant subtotal + shipping - discount = total.
          discountCents = shippingCostCents;
        } else {
          discountCents = redemption.discountCents ?? 0;
        }
      }

      const totalCents = priced.subtotalCents + shippingCostCents - (discountCents ?? 0);

      // 5. Create the immutable order snapshot in the initial pending-payment
      //    state. No Stripe call yet (deferred to Task 5): payment.ref stays unset.
      const [order] = await Order.create(
        [
          {
            customerId: new Types.ObjectId(customerId),
            orderNumber: generateOrderNumber(),
            items: orderItems,
            shippingAddress: shippingSnapshot,
            billingAddress: billingSnapshot,
            subtotalCents: priced.subtotalCents,
            shippingCostCents,
            ...(discountCents !== undefined ? { discountCents } : {}),
            ...(couponCode ? { couponCode } : {}),
            totalCents,
            currency: Currency.Mxn,
            status: OrderStatus.PendingPayment,
            statusHistory: [],
            payment: {
              provider: input.paymentProvider ?? PaymentProvider.Stripe,
              status: PaymentStatus.Pending,
            },
            idempotencyKey: input.idempotencyKey,
            reservationId: reservation._id,
            reservationExpiresAt: reservation.expiresAt,
          },
        ],
        { session },
      );

      // Link the reservation back to its order (kept in the same transaction).
      reservation.orderId = order!._id as Types.ObjectId;
      await reservation.save({ session });

      // 6. Clear the cart (in-transaction, rolls back with everything else).
      await cartService.clear(customerId, session);

      created = order!;
    });
  } catch (error) {
    // A concurrent double-submit that lost the unique-index race: the winner's
    // order already exists, so return it rather than surfacing a 409.
    if (isDuplicateKeyError(error)) {
      const winner = await Order.findOne({ customerId, idempotencyKey: input.idempotencyKey });
      if (winner) {
        return finalizePayment(winner);
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }

  // 7. The Mongo transaction has committed. Create the Stripe PaymentIntent as a
  //    separate step OUTSIDE any transaction, then return order + client secret.
  return finalizePayment(created!);
};

// --- Owner-facing reads (always scoped by customerId IN the query) -----------

const listMine = (customerId: string): Promise<OrderDocument[]> =>
  Order.find({ customerId }).sort({ createdAt: -1 }).exec();

const getMine = async (customerId: string, orderId: string): Promise<OrderDocument> => {
  const order = await Order.findOne({ _id: orderId, customerId });
  if (!order) {
    // 404 (not 403) — never leak the existence of another customer's order.
    throw new AppError("Orden no encontrada.", 404);
  }
  return order;
};

// --- Status transitions ------------------------------------------------------

const getByIdOrThrow = async (orderId: string): Promise<OrderDocument> => {
  const order = await Order.findById(orderId);
  if (!order) {
    throw new AppError("Orden no encontrada.", 404);
  }
  return order;
};

/**
 * Reverses a reservation's stock effect when an order leaves the fulfilment
 * path (cancel/refund), picking the CORRECT inverse for the reservation's
 * actual current state — the critical Task 5 correctness point:
 *   - `Active`  (never paid): the units are only *held* (`reserved`), so
 *     `releaseReservation` frees them. `onHand` was never touched.
 *   - `Committed` (paid): the units were permanently sold (`onHand` already
 *     decremented at payment time), so a genuine `restockCommitted` re-increments
 *     `onHand`. A naive `releaseReservation` here would be a no-op and silently
 *     fail to restock.
 * Both underlying ops are idempotent no-ops on an already-terminal reservation.
 */
const reverseReservationStock = async (
  order: OrderDocument,
  session: ClientSession,
): Promise<void> => {
  const reservation = await StockReservation.findById(order.reservationId).session(session);
  if (reservation?.status === ReservationStatus.Committed) {
    await inventoryService.restockCommitted(order.reservationId.toString(), session);
  } else {
    await inventoryService.releaseReservation(order.reservationId.toString(), session);
  }
};

/**
 * Applies a validated transition, pushes a history entry, runs the stock side
 * effects tied to the target state, and persists — the state-flip and its stock
 * effect ALWAYS in one Mongo transaction so they can never diverge. No external
 * payment API is called here (that stays outside any transaction, in `refund` /
 * `finalizePayment`): this function only owns internal state + inventory.
 *   - `paid`: commit the reservation (reserved → sold, `onHand` decremented).
 *   - `cancelled` / `refunded`: reverse the reservation's stock (release if
 *     still active, restock if already committed).
 */
const applyTransition = async (
  order: OrderDocument,
  to: OrderStatus,
  by: string,
  reason?: string,
  shippingPatch?: Partial<OrderShipping> | null,
): Promise<OrderDocument> => {
  const from = order.status;
  assertTransition(from, to);

  // Optional shipping-subdocument mutation, applied ONLY after the transition is
  // validated (so an illegal transition never leaves a dirty document) and
  // BEFORE the history push / save below — it therefore rides along in whichever
  // single save path already runs for this transition (never an extra write):
  //   - `undefined` (every payment/webhook/reconciliation caller): no-op.
  //   - an object: partial merge onto the subdocument, other fields untouched.
  //   - explicit `null`: reset all four shipping fields (fulfilment revert).
  if (shippingPatch === null) {
    order.shipping.carrier = undefined;
    order.shipping.trackingNumber = undefined;
    order.shipping.shippedAt = undefined;
    order.shipping.deliveredAt = undefined;
  } else if (shippingPatch) {
    Object.assign(order.shipping, shippingPatch);
  }

  if (to === OrderStatus.Paid) {
    order.payment.status = PaymentStatus.Paid;
  }
  if (to === OrderStatus.Refunded) {
    order.payment.status = PaymentStatus.Refunded;
  }
  order.statusHistory.push({ from, to, by, ...(reason ? { reason } : {}), at: new Date() });
  order.status = to;

  // Payment success commits the held stock: this is the FIRST real caller of
  // `commitReservation`. Committing stock and flipping the order to `paid` MUST
  // be atomic — otherwise a save failure after the commit already landed would
  // permanently decrement inventory for an order still reading `pending_payment`.
  if (to === OrderStatus.Paid) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await inventoryService.commitReservation(order.reservationId.toString(), session);
        await order.save({ session });
      });
    } finally {
      await session.endSession();
    }
    // Fire-and-forget, OUTSIDE the transaction: certificates, the customer's
    // confirmation email, and the owner's Telegram alert are all best-effort
    // and must never block or fail the payment transition itself (this
    // matters most on the webhook path, whose ACK must stay 200 no matter
    // what — see `markPaidInternal`'s doc comment).
    void dispatchPaidSideEffects(order).catch((error: unknown) => {
      logger.error(
        { err: error, orderId: order.id as string },
        "Fallo el despacho de efectos post-pago.",
      );
    });
    return order;
  }

  // Cancel/refund reverse the stock. The reversal and the status save MUST be
  // atomic: otherwise a save failure after the release/restock already committed
  // would leave stock changed while the order still reads its old status.
  if (to === OrderStatus.Cancelled || to === OrderStatus.Refunded) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await reverseReservationStock(order, session);
        await order.save({ session });
      });
    } finally {
      await session.endSession();
    }
    return order;
  }

  await order.save();
  return order;
};

const markPaid = async (
  orderId: string,
  by: string,
  paymentRef?: string,
): Promise<OrderDocument> => {
  const order = await getByIdOrThrow(orderId);
  if (paymentRef) {
    order.payment.ref = paymentRef;
  }
  return applyTransition(order, OrderStatus.Paid, by);
};

const advance = async (
  orderId: string,
  to: OrderStatus,
  by: string,
  reason?: string,
  shippingPatch?: Partial<OrderShipping> | null,
): Promise<OrderDocument> => {
  // `markPaid` and `refund` are the dedicated entry points for those states
  // (they carry payment side effects); `advance` drives the fulfilment path
  // (processing → shipped → delivered) and cancellation.
  if (to === OrderStatus.Paid) {
    throw new AppError("Usa el pago para marcar la orden como pagada.", 400);
  }
  if (to === OrderStatus.Refunded) {
    throw new AppError("Usa el reembolso para esta transición.", 400);
  }
  const order = await getByIdOrThrow(orderId);
  return applyTransition(order, to, by, reason, shippingPatch);
};

const cancel = async (orderId: string, reason: string, by: string): Promise<OrderDocument> => {
  const order = await getByIdOrThrow(orderId);
  return applyTransition(order, OrderStatus.Cancelled, by, reason);
};

/**
 * Admin-initiated (total) refund. Calls Stripe to actually reverse the charge
 * as a step OUTSIDE any Mongo transaction (same reasoning as `finalizePayment`),
 * THEN transitions to `refunded` + reverses the stock atomically. Stripe will
 * later deliver a `charge.refunded` webhook; that path finds the order already
 * `refunded` and no-ops, so the money is never refunded and the stock never
 * restocked twice.
 */
const refund = async (orderId: string, reason: string, by: string): Promise<OrderDocument> => {
  const order = await getByIdOrThrow(orderId);
  if (order.payment.ref) {
    const provider = getPaymentProvider(order.payment.provider);
    await provider.refund(order.payment.ref);
  }
  return applyTransition(order, OrderStatus.Refunded, by, reason);
};

// --- Payment-event driven transitions (webhook + reconciliation) -------------

/** System actor labels stamped on webhook/reconciliation-driven history entries. */
const WEBHOOK_ACTOR = "system:stripe-webhook";
const RECONCILE_ACTOR = "system:reconcile";

/**
 * Shared "mark paid" path used by BOTH the webhook handler and reconciliation.
 *
 * Idempotent AND tolerant (matching its `cancelByPaymentRef`/`refundByPaymentRef`
 * siblings): it NEVER throws on an illegal transition. This is a hard safety
 * requirement, not politeness — the webhook records the event id BEFORE
 * dispatching, so a throw here becomes a 500 that Stripe retries but the dedupe
 * permanently swallows, silently losing a captured payment. So:
 *   - already `paid` → no-op.
 *   - a legal `→ paid` transition → apply it (commits stock).
 *   - anything else (a success arriving for an order that is already terminal,
 *     e.g. cancelled after a prior failed attempt then retried successfully on
 *     the same intent) → do NOT throw and do NOT auto-transition (re-committing
 *     released stock could oversell). Flag it LOUDLY for manual reconciliation.
 */
const markPaidInternal = async (order: OrderDocument, by: string): Promise<OrderDocument> => {
  if (order.status === OrderStatus.Paid) {
    return order;
  }
  if (!ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.Paid)) {
    logger.error(
      { orderId: order.id, status: order.status, paymentRef: order.payment.ref },
      "PAGO CAPTURADO sobre una orden no pagable — requiere reconciliación manual.",
    );
    // Out-of-band alert so a money-captured / order-terminal mismatch is never
    // missed. Fire-and-forget: never let the alert channel break webhook ack.
    void notifyOwner(
      `⚠️ Pago capturado en Stripe para la orden \`${order.id as string}\` que está en estado ` +
        `"${order.status}" (no pagable). Revisar y reconciliar manualmente.`,
    );
    return order;
  }
  return applyTransition(order, OrderStatus.Paid, by);
};

/** Correlate a gateway PaymentIntent id to its order (primary lookup). */
const findByPaymentRef = (paymentRef: string): Promise<OrderDocument | null> =>
  Order.findOne({ "payment.ref": paymentRef });

/** Webhook `payment_intent.succeeded` → mark paid + commit stock. */
const markPaidByPaymentRef = async (
  paymentRef: string,
  actor: string = WEBHOOK_ACTOR,
): Promise<void> => {
  const order = await findByPaymentRef(paymentRef);
  if (!order) {
    logger.warn({ paymentRef }, "Webhook de pago sin orden correlacionada (succeeded).");
    return;
  }
  await markPaidInternal(order, actor);
};

/** Webhook `payment_intent.payment_failed` / `payment_intent.canceled` → cancel. */
const cancelByPaymentRef = async (
  paymentRef: string,
  reason: string,
  actor: string = WEBHOOK_ACTOR,
): Promise<void> => {
  const order = await findByPaymentRef(paymentRef);
  if (!order) {
    logger.warn({ paymentRef }, "Webhook de pago sin orden correlacionada (failed/canceled).");
    return;
  }
  // Idempotent / legal-only: skip if the target is not a valid next state
  // (already terminal, or already paid). Guards against out-of-order delivery.
  if (!ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.Cancelled)) {
    return;
  }
  await applyTransition(order, OrderStatus.Cancelled, actor, reason);
};

/**
 * Webhook `charge.refunded` (or a lost dispute) → mark refunded + restock.
 * Does NOT call Stripe: the refund already happened at the gateway (that is why
 * this event fired). Idempotent: an order already `refunded` is skipped, so an
 * admin-initiated refund (which already restocked) is not restocked again.
 */
const refundByPaymentRef = async (
  paymentRef: string,
  reason: string,
  actor: string = WEBHOOK_ACTOR,
): Promise<void> => {
  const order = await findByPaymentRef(paymentRef);
  if (!order) {
    logger.warn({ paymentRef }, "Webhook de reembolso sin orden correlacionada.");
    return;
  }
  if (!ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.Refunded)) {
    return;
  }
  await applyTransition(order, OrderStatus.Refunded, actor, reason);
};

/**
 * Reconciliation backstop for a lost/delayed webhook. Finds pending orders whose
 * reservation has expired and asks Stripe for the REAL PaymentIntent status
 * before giving up:
 *   - Stripe says `succeeded` (webhook was lost) → run the shared mark-paid path.
 *   - anything else (still pending, failed, or no ref) → cancel (reservation
 *     released), freeing the held stock.
 * Errors on one order are logged and never abort the sweep of the rest.
 */
const reconcilePendingOrders = async (): Promise<void> => {
  const stale = await Order.find({
    status: OrderStatus.PendingPayment,
    reservationExpiresAt: { $lt: new Date() },
  });

  for (const order of stale) {
    try {
      if (order.payment.ref) {
        const provider = getPaymentProvider(order.payment.provider);
        const intent = await provider.retrievePaymentIntent(order.payment.ref);
        if (intent.status === PaymentStatus.Paid) {
          await markPaidInternal(order, RECONCILE_ACTOR);
          continue;
        }
      }
      await applyTransition(
        order,
        OrderStatus.Cancelled,
        RECONCILE_ACTOR,
        "expiración de reserva",
      );
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, "Fallo al reconciliar una orden pendiente.");
    }
  }
};

// --- Admin-facing ------------------------------------------------------------

interface AdminOrderFilters {
  status?: OrderStatus;
  customerId?: string;
}

const adminList = (filters: AdminOrderFilters = {}): Promise<OrderDocument[]> => {
  const query: Record<string, unknown> = {};
  if (filters.status) {
    query.status = filters.status;
  }
  if (filters.customerId) {
    query.customerId = filters.customerId;
  }
  return Order.find(query).sort({ createdAt: -1 }).exec();
};

const adminGet = (orderId: string): Promise<OrderDocument> => getByIdOrThrow(orderId);

/**
 * Admin-audited entry points for the direct order-status/refund HTTP routes
 * (`admin.order.routes.ts`). Delegate to `advance`/`refund` (the shared
 * state-machine primitives also used by the shipping domain and by the
 * webhook/reconciliation paths with system actors) and then record a generic
 * audit entry. Shipping's own admin actions (`assignGuide`, `markDelivered`,
 * etc.) call `advance` directly instead of these wrappers — they already
 * record their own richer, domain-specific audit entries, so routing them
 * through here too would double-audit the same mutation.
 */
const adminAdvance = async (
  orderId: string,
  to: OrderStatus,
  actor: Actor,
  reason?: string,
  shippingPatch?: Partial<OrderShipping> | null,
): Promise<OrderDocument> => {
  const order = await advance(orderId, to, actor.id, reason, shippingPatch);
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ADVANCE_ORDER_STATUS",
    module: MODULE,
    targetId: orderId,
    after: { status: to, ...(reason ? { reason } : {}) },
    ip: actor.ip,
  });
  return order;
};

const adminRefund = async (
  orderId: string,
  reason: string,
  actor: Actor,
): Promise<OrderDocument> => {
  const order = await refund(orderId, reason, actor.id);
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "REFUND_ORDER",
    module: MODULE,
    targetId: orderId,
    after: { reason },
    ip: actor.ip,
  });
  return order;
};

export type { CreateOrderInput, CreateOrderResult, AdminOrderFilters };
export {
  ALLOWED_TRANSITIONS,
  createOrder,
  listMine,
  getMine,
  markPaid,
  advance,
  cancel,
  refund,
  markPaidByPaymentRef,
  cancelByPaymentRef,
  refundByPaymentRef,
  reconcilePendingOrders,
  adminList,
  adminGet,
  adminAdvance,
  adminRefund,
};
