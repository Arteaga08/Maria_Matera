import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { OrderStatus, PaymentStatus, ReservationStatus } from "@maria-matera/shared";
import { Customer } from "../../src/models/Customer.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import { Order } from "../../src/models/Order.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import { ProcessedWebhookEvent } from "../../src/models/ProcessedWebhookEvent.js";

/**
 * Stripe webhook HTTP surface (Milestone 5, Task 5). Verifies the route is
 * mounted BEFORE json/cookie/sanitize/verifyOrigin (raw-body + signature auth),
 * that signature verification gates everything, that delivery is deduped, and
 * that each event drives the correct order/inventory transition. The Stripe
 * adapter is mocked: a "valid" signature parses the raw body, anything else
 * throws (the SDK's real behavior).
 */

const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

// Imported after the mock is registered (dynamic import on purpose).
const { buildApp } = await import("../../src/app.js");
const orderService = await import("../../src/services/order.service.js");

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
let counter = 0;
let piSeq = 0;
let eventSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.retrievePaymentIntent.mockReset();
  stripeMock.refund.mockReset();
  stripeMock.constructWebhookEvent.mockReset();
  stripeMock.createPaymentIntent.mockImplementation(async () => {
    piSeq += 1;
    return { ref: `pi_mock_${piSeq}`, clientSecret: `cs_mock_${piSeq}` };
  });
  stripeMock.refund.mockResolvedValue(undefined);
  // Real Stripe verifies the signature over the raw bytes; here a "valid"
  // signature yields the parsed event, anything else throws.
  stripeMock.constructWebhookEvent.mockImplementation((raw: Buffer, signature?: string) => {
    if (signature !== "valid") {
      throw new Error("Invalid signature");
    }
    return JSON.parse(raw.toString("utf8"));
  });
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
    email: `wh-${counter}@test.com`,
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
    slug: `anillo-wh-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-WH-${counter}`,
    onHand,
  });
  return { product, variant };
};

const checkout = async (key: string, priceCents = 100000, onHand = 10, qty = 2) => {
  const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
  const { product, variant } = await makeProduct(priceCents, onHand);
  await Cart.create({
    customerId,
    items: [{ productId: product._id, variantId: variant._id, sku: variant.sku, qty }],
  });
  const { order } = await orderService.createOrder(customerId, {
    idempotencyKey: key,
    shippingAddressId,
    billingAddressId,
  });
  return { order, variant, customerId };
};

const post = (event: unknown, signature = "valid") =>
  request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("stripe-signature", signature)
    .send(JSON.stringify(event));

const paymentIntentEvent = (type: string, piId: string, orderId: string) => ({
  id: `evt_${(eventSeq += 1)}`,
  type,
  data: { object: { id: piId, metadata: { orderId } } },
});

const chargeEvent = (type: string, piId: string, extra: Record<string, unknown> = {}) => ({
  id: `evt_${(eventSeq += 1)}`,
  type,
  data: { object: { id: `ch_${eventSeq}`, payment_intent: piId, ...extra } },
});

describe("Stripe webhook — signature gate", () => {
  it("rejects an invalid signature with 400 and processes nothing", async () => {
    const { order, variant } = await checkout("wh-badsig-1");
    const event = paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id);

    const res = await post(event, "bad-signature");

    expect(res.status).toBe(400);
    // Nothing happened: order untouched, no event recorded, stock still only held.
    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.PendingPayment);
    expect(await ProcessedWebhookEvent.countDocuments({})).toBe(0);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);
  });
});

describe("Stripe webhook — payment_intent.succeeded", () => {
  it("marks the order paid, commits the reservation, and does NOT touch the cart", async () => {
    const { order, variant, customerId } = await checkout("wh-succeeded-1", 100000, 10, 2);
    // Put a NEW item in the (already-cleared but still-existing) cart to prove the
    // webhook never clears it. Update in place — Cart has a unique index per customer.
    const other = await makeProduct(50000, 5);
    await Cart.updateOne(
      { customerId },
      { items: [{ productId: other.product._id, variantId: other.variant._id, sku: other.variant.sku, qty: 1 }] },
    );

    const event = paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id);
    const res = await post(event);
    expect(res.status).toBe(200);

    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    expect(paid!.payment.status).toBe(PaymentStatus.Paid);

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8);
    expect(afterVariant!.reserved).toBe(0);
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe(ReservationStatus.Committed);

    // Cart NOT re-cleared: the item added post-checkout survives.
    const cart = await Cart.findOne({ customerId });
    expect(cart!.items).toHaveLength(1);
  });

  it("dedupes redelivery of the same event id: 200 without double-committing stock", async () => {
    const { order, variant } = await checkout("wh-dupe-1", 100000, 10, 2);
    const event = paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id);

    const first = await post(event);
    const second = await post(event); // identical event id

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    // Committed exactly once.
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8); // not 6
    expect(await ProcessedWebhookEvent.countDocuments({})).toBe(1);
  });
});

describe("Stripe webhook — failure / cancellation", () => {
  it("payment_intent.payment_failed is NOT terminal: order stays pending, stock still held", async () => {
    const { order, variant } = await checkout("wh-failed-1", 100000, 10, 2);
    const event = paymentIntentEvent("payment_intent.payment_failed", order.payment.ref!, order.id);

    const res = await post(event);
    expect(res.status).toBe(200);

    // A failed attempt can still be retried on the same intent — never cancel here.
    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.PendingPayment);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(2); // still held
    expect(afterVariant!.onHand).toBe(10);
  });

  it("payment_intent.canceled cancels the order and releases the held stock", async () => {
    const { order, variant } = await checkout("wh-canceled-1", 100000, 10, 2);
    const event = paymentIntentEvent("payment_intent.canceled", order.payment.ref!, order.id);

    const res = await post(event);
    expect(res.status).toBe(200);

    const cancelled = await Order.findById(order.id);
    expect(cancelled!.status).toBe(OrderStatus.Cancelled);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0);
    expect(afterVariant!.onHand).toBe(10); // released, never sold
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe(ReservationStatus.Released);
  });
});

describe("Stripe webhook — dispatch failure cleans up the dedupe record", () => {
  it("deletes the ProcessedWebhookEvent on a dispatch failure so a genuine retry is NOT deduped", async () => {
    const { order } = await checkout("wh-dispatch-fail-1", 100000, 10, 2);
    const event = paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id);

    // Force a hard failure downstream of the dedupe insert (simulating e.g. a
    // transient DB error inside dispatchEvent) by making the order-status
    // transition throw for this one delivery.
    const failure = new Error("Simulated downstream failure");
    const spy = vi
      .spyOn(orderService, "markPaidByPaymentRef")
      .mockRejectedValueOnce(failure);

    const first = await post(event);
    expect(first.status).toBe(500);
    // The dedupe record must NOT survive a failed dispatch.
    expect(await ProcessedWebhookEvent.countDocuments({ eventId: event.id })).toBe(0);
    // Order untouched — the failure happened before the transition completed.
    const stillPending = await Order.findById(order.id);
    expect(stillPending!.status).toBe(OrderStatus.PendingPayment);

    spy.mockRestore();

    // A genuine Stripe retry of the SAME event id must now be reprocessed
    // (not deduped) and succeed.
    const second = await post(event);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBeUndefined();
    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    expect(await ProcessedWebhookEvent.countDocuments({ eventId: event.id })).toBe(1);
  });
});

describe("Stripe webhook — unhandled events", () => {
  it("acknowledges an unhandled event type (200) without side effects", async () => {
    const event = {
      id: `evt_${(eventSeq += 1)}`,
      type: "invoice.paid",
      data: { object: { id: "in_123" } },
    };
    const res = await post(event);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe("Stripe webhook — charge.refunded / dispute", () => {
  it("charge.refunded (FULL) on a paid order marks it refunded and RESTOCKS onHand", async () => {
    const { order, variant } = await checkout("wh-refund-1", 100000, 10, 2);
    // First pay it (commits stock, onHand 8).
    await post(paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id));
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8);

    // Full refund: amount_refunded === amount.
    const res = await post(
      chargeEvent("charge.refunded", order.payment.ref!, { amount: 200000, amount_refunded: 200000 }),
    );
    expect(res.status).toBe(200);

    const refunded = await Order.findById(order.id);
    expect(refunded!.status).toBe(OrderStatus.Refunded);
    // Restocked, not merely released.
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);
  });

  it("charge.refunded (PARTIAL) is acknowledged without mutating the order or over-restocking", async () => {
    const { order, variant } = await checkout("wh-refund-partial-1", 100000, 10, 2);
    await post(paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id));
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8);

    // Partial refund: amount_refunded < amount → out of scope, no mutation.
    const res = await post(
      chargeEvent("charge.refunded", order.payment.ref!, { amount: 200000, amount_refunded: 80000 }),
    );
    expect(res.status).toBe(200);

    const stillPaid = await Order.findById(order.id);
    expect(stillPaid!.status).toBe(OrderStatus.Paid); // unchanged
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8); // NOT restocked
  });

  it("charge.dispute.created is acknowledged (200) with NO stock/status effect", async () => {
    const { order, variant } = await checkout("wh-dispute-open-1", 100000, 10, 2);
    await post(paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id));

    const res = await post(chargeEvent("charge.dispute.created", order.payment.ref!));
    expect(res.status).toBe(200);

    const stillPaid = await Order.findById(order.id);
    expect(stillPaid!.status).toBe(OrderStatus.Paid);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8); // untouched
  });

  it("charge.dispute.closed with status=lost refunds and restocks", async () => {
    const { order, variant } = await checkout("wh-dispute-lost-1", 100000, 10, 2);
    await post(paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id));

    const res = await post(chargeEvent("charge.dispute.closed", order.payment.ref!, { status: "lost" }));
    expect(res.status).toBe(200);

    const refunded = await Order.findById(order.id);
    expect(refunded!.status).toBe(OrderStatus.Refunded);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);
  });

  it("charge.dispute.closed with status=won leaves the sale and stock intact", async () => {
    const { order, variant } = await checkout("wh-dispute-won-1", 100000, 10, 2);
    await post(paymentIntentEvent("payment_intent.succeeded", order.payment.ref!, order.id));

    const res = await post(chargeEvent("charge.dispute.closed", order.payment.ref!, { status: "won" }));
    expect(res.status).toBe(200);

    const stillPaid = await Order.findById(order.id);
    expect(stillPaid!.status).toBe(OrderStatus.Paid);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8);
  });
});
