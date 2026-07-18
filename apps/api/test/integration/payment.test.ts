import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { OrderStatus, PaymentStatus, ReservationStatus } from "@maria-matera/shared";
import { Customer } from "../../src/models/Customer.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import { Order } from "../../src/models/Order.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import * as orderService from "../../src/services/order.service.js";

/**
 * Payment integration (Milestone 5, Task 5) at the SERVICE boundary. The Stripe
 * adapter is mocked so no network call is made, but the order / inventory / state
 * machinery is exercised for real against a replica set. Covers: the
 * post-transaction PaymentIntent creation (amount/currency/idempotency), the
 * commit-on-paid inventory move, the committed-vs-active refund restock, and the
 * reconciliation backstop for a lost/delayed webhook.
 */

const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

let counter = 0;
let piSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.retrievePaymentIntent.mockReset();
  stripeMock.refund.mockReset();
  stripeMock.createPaymentIntent.mockImplementation(async () => {
    piSeq += 1;
    return { ref: `pi_mock_${piSeq}`, clientSecret: `cs_mock_${piSeq}` };
  });
  stripeMock.retrievePaymentIntent.mockImplementation(async (ref: string) => ({
    ref,
    status: "requires_payment_method",
    clientSecret: `cs_for_${ref}`,
  }));
  stripeMock.refund.mockResolvedValue(undefined);
});

const address = (overrides: Record<string, unknown> = {}) => ({
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
  ...overrides,
});

const makeCustomer = async () => {
  counter += 1;
  const customer = await Customer.create({
    name: "Cliente",
    email: `pay-${counter}@test.com`,
    password: "Password123",
    addresses: [address({ label: "Envío" }), address({ label: "Facturación" })],
  });
  return {
    customerId: customer.id as string,
    shippingAddressId: customer.addresses[0]!._id.toString(),
    billingAddressId: customer.addresses[1]!._id.toString(),
  };
};

const makeProduct = async (priceCents = 100000, onHand = 10) => {
  counter += 1;
  const product = await Product.create({
    name: `Anillo ${counter}`,
    slug: `anillo-pay-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-PAY-${counter}`,
    onHand,
  });
  return { product, variant };
};

const seedCart = (
  customerId: string,
  product: { _id: mongoose.Types.ObjectId },
  variant: { _id: mongoose.Types.ObjectId; sku: string },
  qty: number,
) =>
  Cart.create({
    customerId,
    items: [{ productId: product._id, variantId: variant._id, sku: variant.sku, qty }],
  });

const checkout = async (key: string, priceCents = 100000, onHand = 10, qty = 2) => {
  const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
  const { product, variant } = await makeProduct(priceCents, onHand);
  await seedCart(customerId, product, variant, qty);
  const { order, clientSecret } = await orderService.createOrder(customerId, {
    idempotencyKey: key,
    shippingAddressId,
    billingAddressId,
  });
  return { order, clientSecret, variant, customerId };
};

describe("Payment — PaymentIntent creation (outside the Mongo transaction)", () => {
  it("creates a PaymentIntent with the order's amount/currency/id and returns the client secret", async () => {
    const { order, clientSecret } = await checkout("pay-create-1", 150000, 10, 2);

    expect(stripeMock.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripeMock.createPaymentIntent).toHaveBeenCalledWith({
      amountCents: 300000,
      currency: "MXN",
      metadata: { orderId: order.id },
      // Per-order idempotency key = order id (never the per-customer client key).
      idempotencyKey: order.id,
    });
    expect(clientSecret).toBe("cs_mock_1");

    const persisted = await Order.findById(order.id);
    expect(persisted!.payment.ref).toBe("pi_mock_1");
    expect(persisted!.status).toBe(OrderStatus.PendingPayment);
  });

  it("does not mint a second intent on an idempotent retry; retrieves the existing secret", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, product, variant, 1);

    const first = await orderService.createOrder(customerId, {
      idempotencyKey: "pay-retry-1",
      shippingAddressId,
      billingAddressId,
    });
    const second = await orderService.createOrder(customerId, {
      idempotencyKey: "pay-retry-1",
      shippingAddressId,
      billingAddressId,
    });

    expect(second.order.id).toBe(first.order.id);
    expect(stripeMock.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripeMock.retrievePaymentIntent).toHaveBeenCalledWith(first.order.payment.ref);
    expect(second.clientSecret).toBe(`cs_for_${first.order.payment.ref}`);
  });

  it("retries the Stripe call when a prior attempt left the order without a ref", async () => {
    const { order } = await checkout("pay-missing-ref-1");
    // Simulate a prior attempt that committed the order but crashed before the
    // ref was persisted.
    await Order.updateOne({ _id: order.id }, { $unset: { "payment.ref": 1 } });
    stripeMock.createPaymentIntent.mockClear();

    const customer = await Order.findById(order.id);
    const retry = await orderService.createOrder(customer!.customerId.toString(), {
      idempotencyKey: order.idempotencyKey,
      shippingAddressId: "unused",
      billingAddressId: "unused",
    });

    expect(retry.order.id).toBe(order.id);
    expect(stripeMock.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(retry.clientSecret).toBeTruthy();
    const persisted = await Order.findById(order.id);
    expect(persisted!.payment.ref).toBeTruthy();
  });
});

describe("Payment — mark paid commits the reservation", () => {
  it("markPaidByPaymentRef moves the order to paid and permanently decrements onHand", async () => {
    const { order, variant } = await checkout("pay-paid-1", 100000, 10, 2);
    expect((await ProductVariant.findById(variant.id))!.reserved).toBe(2);

    await orderService.markPaidByPaymentRef(order.payment.ref!);

    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    expect(paid!.payment.status).toBe(PaymentStatus.Paid);

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8); // sold
    expect(afterVariant!.reserved).toBe(0);
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe(ReservationStatus.Committed);
  });

  it("is idempotent: a second succeeded signal does not double-commit stock", async () => {
    const { order, variant } = await checkout("pay-paid-idem-1", 100000, 10, 2);
    await orderService.markPaidByPaymentRef(order.payment.ref!);
    await orderService.markPaidByPaymentRef(order.payment.ref!);

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8); // not 6
  });

  it("a late success on an already-cancelled order does NOT throw and does not re-commit stock", async () => {
    const { order, variant } = await checkout("pay-late-success-1", 100000, 10, 2);
    // Cancel first (as if payment_intent.canceled or reconciliation fired), which
    // releases the reservation.
    await orderService.cancel(order.id, "cancelada", "test");
    expect((await ProductVariant.findById(variant.id))!.reserved).toBe(0);

    // A late `succeeded` must be tolerated (never throw — a throw would be a
    // dedupe-swallowed 500 that loses the captured payment silently).
    await expect(orderService.markPaidByPaymentRef(order.payment.ref!)).resolves.toBeUndefined();

    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.Cancelled); // unchanged, flagged for manual review
    // Stock is NOT re-committed (would risk overselling already-released units).
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);
  });
});

describe("Payment — refund of a committed (paid) order RESTOCKS", () => {
  it("re-increments onHand for a paid-then-refunded order (not a mere release)", async () => {
    const { order, variant } = await checkout("pay-refund-1", 100000, 10, 2);
    await orderService.markPaidByPaymentRef(order.payment.ref!);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8);

    await orderService.refundByPaymentRef(order.payment.ref!, "Reembolso");

    const refunded = await Order.findById(order.id);
    expect(refunded!.status).toBe(OrderStatus.Refunded);
    // Genuine restock: onHand went back up. A naive release would have left it at 8.
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(10);
    expect(afterVariant!.reserved).toBe(0);
  });

  it("admin refund() calls Stripe once and is not double-restocked by the later webhook", async () => {
    const { order, variant } = await checkout("pay-refund-2", 100000, 10, 2);
    await orderService.markPaidByPaymentRef(order.payment.ref!);

    await orderService.refund(order.id, "Defectuoso", "admin-1");
    expect(stripeMock.refund).toHaveBeenCalledWith(order.payment.ref);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);

    // The charge.refunded webhook then arrives; order already refunded → no-op.
    await orderService.refundByPaymentRef(order.payment.ref!, "Reembolso procesado en Stripe.");
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10); // not 12
  });
});

describe("Payment — reconciliation backstop", () => {
  it("marks an expired pending order paid when Stripe reports it actually succeeded", async () => {
    const { order, variant } = await checkout("pay-recon-paid-1", 100000, 10, 2);
    await Order.updateOne(
      { _id: order.id },
      { reservationExpiresAt: new Date(Date.now() - 1000) },
    );
    stripeMock.retrievePaymentIntent.mockResolvedValue({
      ref: order.payment.ref!,
      status: "succeeded",
    });

    await orderService.reconcilePendingOrders();

    const reconciled = await Order.findById(order.id);
    expect(reconciled!.status).toBe(OrderStatus.Paid);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8);
  });

  it("cancels an expired pending order when Stripe still reports it unpaid", async () => {
    const { order, variant } = await checkout("pay-recon-cancel-1", 100000, 10, 2);
    await Order.updateOne(
      { _id: order.id },
      { reservationExpiresAt: new Date(Date.now() - 1000) },
    );
    // Default mock already returns a non-succeeded status.

    await orderService.reconcilePendingOrders();

    const reconciled = await Order.findById(order.id);
    expect(reconciled!.status).toBe(OrderStatus.Cancelled);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0); // reservation released
    expect(afterVariant!.onHand).toBe(10);
  });

  it("leaves a still-valid (unexpired) pending order untouched", async () => {
    const { order } = await checkout("pay-recon-skip-1", 100000, 10, 2);
    await orderService.reconcilePendingOrders();
    const untouched = await Order.findById(order.id);
    expect(untouched!.status).toBe(OrderStatus.PendingPayment);
  });

  it("keeps sweeping the rest when Stripe retrieve throws for one stale order", async () => {
    const a = await checkout("pay-recon-throw-a", 100000, 10, 2);
    const b = await checkout("pay-recon-throw-b", 100000, 10, 2);
    await Order.updateMany(
      { _id: { $in: [a.order.id, b.order.id] } },
      { reservationExpiresAt: new Date(Date.now() - 1000) },
    );
    // Order a's retrieve rejects (network); order b's returns a non-succeeded status.
    stripeMock.retrievePaymentIntent.mockImplementation(async (ref: string) => {
      if (ref === a.order.payment.ref) {
        throw new Error("network error talking to Stripe");
      }
      return { ref, status: "requires_payment_method" };
    });

    await orderService.reconcilePendingOrders();

    // a: the per-order try/catch absorbed the throw — left pending for a later sweep.
    expect((await Order.findById(a.order.id))!.status).toBe(OrderStatus.PendingPayment);
    // b: the sweep continued and cancelled it (unpaid + expired).
    expect((await Order.findById(b.order.id))!.status).toBe(OrderStatus.Cancelled);
  });
});
