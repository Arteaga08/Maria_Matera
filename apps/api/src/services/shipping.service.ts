import { Carrier, OrderStatus, UserType } from "@maria-matera/shared";
import { buildTrackingUrl } from "../config/carriers.js";
import { logger } from "../config/logger.js";
import { Customer } from "../models/Customer.js";
import { Order, type OrderDocument } from "../models/Order.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";
import { emailService } from "./email.service.js";
import * as orderService from "./order.service.js";

/**
 * Shipping business logic (Milestone 7, Task 3). A thin admin-mutation layer
 * on top of `order.service.ts`'s already-atomic status machine: every method
 * that changes order status delegates entirely to `adminAdvance` (which rides
 * the SAME save as the shipping-field patch — see Task 2) rather than
 * re-implementing any transition/validation logic here. `editGuide` is the one
 * exception by design: it corrects carrier/tracking-number typos on an
 * already-shipped order with NO status change, so it goes through `adminGet` +
 * a plain `order.save()` instead.
 */

const MODULE = "shipping";

interface AssignGuideInput {
  carrier: Carrier;
  trackingNumber: string;
}

interface EditGuideInput {
  carrier?: Carrier;
  trackingNumber?: string;
}

interface ShipmentView {
  order: OrderDocument;
  trackingUrl?: string;
}

interface PublicTrackResult {
  carrier: Carrier;
  trackingNumber: string;
  trackingUrl?: string;
  status: OrderStatus;
  shippedAt?: Date;
  deliveredAt?: Date;
}

/**
 * Assigns a carrier + tracking number and transitions `processing → shipped`
 * atomically (via `adminAdvance`'s shipping-patch argument — no separate
 * `order.save()` here). The shipped-notification email is sent AFTER the
 * shipment is already persisted, wrapped in its own try/catch: a transport
 * failure must never surface as an HTTP error for an order that already shows
 * "shipped" in the database — that mismatch (email failure → 500 returned
 * post-persist) is a real bug we audited in a reference repo and are
 * deliberately avoiding here.
 */
const assignGuide = async (
  orderId: string,
  input: AssignGuideInput,
  actor: Actor,
  reason?: string,
): Promise<OrderDocument> => {
  const order = await orderService.adminAdvance(orderId, OrderStatus.Shipped, actor.id, reason, {
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
    shippedAt: new Date(),
  });

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ASSIGN_GUIDE",
    module: MODULE,
    targetId: orderId,
    after: { carrier: input.carrier, trackingNumber: input.trackingNumber },
    ip: actor.ip,
  });

  try {
    const customer = await Customer.findById(order.customerId);
    if (customer) {
      await emailService.sendShippedEmail(customer.email, {
        orderNumber: order.orderNumber,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        trackingUrl: buildTrackingUrl(input.carrier, input.trackingNumber),
      });
    }
  } catch (error) {
    logger.error(
      { err: error, orderId },
      "No se pudo enviar el correo de notificación de envío.",
    );
  }

  return order;
};

/**
 * Transitions `shipped → delivered`, merging `deliveredAt` onto the existing
 * `shipping` subdocument — carrier/trackingNumber/shippedAt set by
 * `assignGuide` stay untouched (Task 2's object-patch merge semantics).
 */
const markDelivered = async (
  orderId: string,
  actor: Actor,
  reason?: string,
): Promise<OrderDocument> => {
  const order = await orderService.adminAdvance(
    orderId,
    OrderStatus.Delivered,
    actor.id,
    reason,
    { deliveredAt: new Date() },
  );

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "MARK_DELIVERED",
    module: MODULE,
    targetId: orderId,
    ip: actor.ip,
  });

  return order;
};

/**
 * Corrects a typo'd carrier/tracking number on an already-shipped order — no
 * status change, so this does NOT go through `adminAdvance`. Only the fields
 * present in `input` are applied (partial update); "at least one field
 * provided" is Task 4 validator territory, not re-checked here.
 * Caller (validate(editGuideSchema)) guarantees at least one of
 * carrier/trackingNumber is present.
 * Intentionally unguarded: no status check here — this corrects a typo on the
 * current shipping data regardless of order status. Revisit if that
 * assumption changes.
 */
const editGuide = async (
  orderId: string,
  input: EditGuideInput,
  actor: Actor,
  reason?: string,
): Promise<OrderDocument> => {
  const order = await orderService.adminGet(orderId);
  const before = {
    carrier: order.shipping.carrier,
    trackingNumber: order.shipping.trackingNumber,
  };

  if (input.carrier !== undefined) {
    order.shipping.carrier = input.carrier;
  }
  if (input.trackingNumber !== undefined) {
    order.shipping.trackingNumber = input.trackingNumber;
  }
  await order.save();

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "EDIT_GUIDE",
    module: MODULE,
    targetId: orderId,
    before,
    after: {
      carrier: order.shipping.carrier,
      trackingNumber: order.shipping.trackingNumber,
      ...(reason ? { reason } : {}),
    },
    ip: actor.ip,
  });

  return order;
};

/**
 * Undoes a shipment: `shipped → processing`, clearing all four shipping
 * fields atomically via `adminAdvance`'s explicit `null` patch (Task 2). A
 * reason is REQUIRED (not optional) — undoing a shipment needs a stated
 * justification for the audit trail.
 */
const revertShipment = async (
  orderId: string,
  reason: string,
  actor: Actor,
): Promise<OrderDocument> => {
  const order = await orderService.adminAdvance(
    orderId,
    OrderStatus.Processing,
    actor.id,
    reason,
    null,
  );

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "REVERT_SHIPMENT",
    module: MODULE,
    targetId: orderId,
    after: { reason },
    ip: actor.ip,
  });

  return order;
};

/**
 * Normal `paid → processing` fulfilment-start step. Deliberately does NOT pass
 * a shipping patch (unlike `revertShipment`, which explicitly clears shipping
 * with `null`): these two paths can land on the same target status, but their
 * intents are distinct and kept separate here even though shipping is already
 * empty at this point so it wouldn't mechanically matter.
 */
const markProcessing = async (
  orderId: string,
  actor: Actor,
  reason?: string,
): Promise<OrderDocument> => {
  const order = await orderService.adminAdvance(orderId, OrderStatus.Processing, actor.id, reason);

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "MARK_PROCESSING",
    module: MODULE,
    targetId: orderId,
    ip: actor.ip,
  });

  return order;
};

/** Admin read: the order plus its derived tracking URL (if fully set). */
const getShipment = async (orderId: string): Promise<ShipmentView> => {
  const order = await orderService.adminGet(orderId);
  const { carrier, trackingNumber } = order.shipping;
  const trackingUrl =
    carrier && trackingNumber ? buildTrackingUrl(carrier, trackingNumber) : undefined;
  return { order, trackingUrl };
};

/**
 * PUBLIC, unauthenticated read by tracking number. Anti-enumeration: a flat
 * 404 for "no such tracking number" — the same posture as `getMine` in
 * `order.service.ts`, never distinguishing "wrong number" from "exists but not
 * shipped yet". The returned payload is deliberately minimal/PII-free: no
 * `customerId`, `orderNumber`, addresses, items, or totals — this is a public
 * endpoint.
 */
const publicTrack = async (trackingNumber: string): Promise<PublicTrackResult> => {
  const order = await Order.findOne({ "shipping.trackingNumber": trackingNumber });
  // The query matches on `shipping.trackingNumber`, so it's guaranteed present
  // on a hit — but `shipping.carrier` is a SEPARATE optional field with no
  // such guarantee (e.g. a hypothetical partial `editGuide` update that only
  // ever touched `trackingNumber`). Treat that as "not trackable" too, same
  // flat 404 as a genuinely unknown number — never let an undefined carrier
  // reach this typed-as-`Carrier` public payload.
  if (!order || !order.shipping.carrier || !order.shipping.trackingNumber) {
    throw new AppError("Guía no encontrada.", 404);
  }

  const { carrier, trackingNumber: number, shippedAt, deliveredAt } = order.shipping;
  return {
    carrier,
    trackingNumber: number,
    trackingUrl: buildTrackingUrl(carrier, number),
    status: order.status,
    shippedAt,
    deliveredAt,
  };
};

export type { AssignGuideInput, EditGuideInput, ShipmentView, PublicTrackResult };
export {
  assignGuide,
  markDelivered,
  editGuide,
  revertShipment,
  markProcessing,
  getShipment,
  publicTrack,
};
