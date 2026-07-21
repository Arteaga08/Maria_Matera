import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { OrderStatus, PaymentProvider, PaymentStatus, ReservationStatus } from "@maria-matera/shared";
import { Customer } from "../../src/models/Customer.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import { Order } from "../../src/models/Order.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import { ProcessedWebhookEvent } from "../../src/models/ProcessedWebhookEvent.js";

/**
 * Mercado Pago webhook HTTP surface (Milestone 6, Task 4). Mirrors
 * `webhook.test.ts`'s (Stripe) structure: verifies the route is mounted
 * BEFORE json/cookie/sanitize/verifyOrigin (raw-body + signature auth), that
 * signature verification gates everything, that delivery is deduped, and that
 * each `getPaymentById` outcome drives the correct order/inventory transition.
 * The Mercado Pago adapter is mocked at the module boundary: a "valid"
 * signature parses the raw body as the event, anything else throws (mirrors
 * the real adapter's HMAC failure).
 */

const mercadopagoMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
  getPaymentById: vi.fn(),
}));
vi.mock("../../src/services/payment/mercadopago.provider.js", () => ({
  mercadopagoProvider: mercadopagoMock,
}));

// eslint-disable-next-line import/first -- must import after the mock is registered.
const { buildApp } = await import("../../src/app.js");
const orderService = await import("../../src/services/order.service.js");

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
let counter = 0;
let eventSeq = 0;

beforeEach(() => {
  mercadopagoMock.createPaymentIntent.mockReset();
  mercadopagoMock.retrievePaymentIntent.mockReset();
  mercadopagoMock.refund.mockReset();
  mercadopagoMock.constructWebhookEvent.mockReset();
  mercadopagoMock.getPaymentById.mockReset();

  // Mirrors the real adapter's correlation contract: `ref` === the order id
  // supplied via `metadata.orderId`.
  mercadopagoMock.createPaymentIntent.mockImplementation(
    async (input: { metadata?: Record<string, string> }) => ({
      ref: input.metadata?.orderId,
      clientSecret: "https://mp.example/init",
    }),
  );
  mercadopagoMock.refund.mockResolvedValue(undefined);
  // Real MP verifies an HMAC over a manifest built from the signature/meta,
  // then returns `{ id, type, data: { object: { id: dataId } } }` — mirror
  // that shape (rather than just echoing the raw body) so `meta.dataId`
  // (which the controller resolves from the query OR falls back to the raw
  // body's `data.id`, per MP's real webhook wire format) is what actually
  // ends up correlating the payment, exactly like production.
  mercadopagoMock.constructWebhookEvent.mockImplementation(
    (raw: Buffer, signature?: string, meta?: { requestId?: string; dataId?: string }) => {
      if (signature !== "valid") {
        throw new Error("Invalid signature");
      }
      const parsed = JSON.parse(raw.toString("utf8")) as { id?: string; type?: string };
      return {
        id: parsed.id ?? "",
        type: parsed.type ?? "unknown",
        data: { object: { id: meta?.dataId ?? "" } },
      };
    },
  );
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
    email: `mpwh-${counter}@test.com`,
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
    slug: `anillo-mpwh-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-MPWH-${counter}`,
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
    paymentProvider: PaymentProvider.MercadoPago,
  });
  return { order, variant, customerId };
};

const post = (event: unknown, signature = "valid", dataId?: string) => {
  const req = request(app)
    .post("/api/v1/webhooks/mercadopago")
    .set("Content-Type", "application/json");
  if (dataId !== undefined) {
    void req.query({ "data.id": dataId });
  }
  return req
    .set("x-signature", signature)
    .set("x-request-id", `req-${(eventSeq += 1)}`)
    .send(JSON.stringify(event));
};

// Real MP notification wire format: `{ id, type, data: { id: <paymentId> } }`
// — the OUTPUT of `constructWebhookEvent` nests the id under `data.object`
// instead (see the mock above), so tests read the correlating payment id off
// `event.data.object.id`, but the RAW body posted here uses MP's actual
// `data.id` shape (needed to exercise `dataIdOf`'s body-fallback branch).
const paymentEvent = (paymentId: string) => ({
  id: `notif_${(eventSeq += 1)}`,
  type: "payment",
  data: { id: paymentId },
});

describe("Mercado Pago webhook — signature gate", () => {
  it("rejects an invalid signature with 400 and processes nothing", async () => {
    const { order, variant } = await checkout("mpwh-badsig-1");
    const event = paymentEvent(order.payment.ref!);

    const res = await post(event, "bad-signature", order.payment.ref!);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: "fail", message: "Firma de webhook inválida." });
    // Nothing happened: order untouched, no event recorded, stock still only held.
    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.PendingPayment);
    expect(await ProcessedWebhookEvent.countDocuments({})).toBe(0);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);
  });
});

describe("Mercado Pago webhook — payment approved", () => {
  it("marks the order paid, commits the reservation, and stamps the mercadopago webhook actor", async () => {
    const { order, variant } = await checkout("mpwh-paid-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({
      status: PaymentStatus.Paid,
      orderId: order.id,
    });

    const event = paymentEvent(order.payment.ref!);
    const res = await post(event, "valid", order.payment.ref!);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    expect(paid!.payment.status).toBe(PaymentStatus.Paid);
    // Proves 4b: the mercadopago webhook stamps ITS OWN actor, not Stripe's.
    const last = paid!.statusHistory[paid!.statusHistory.length - 1]!;
    expect(last.by).toBe("system:mercadopago-webhook");

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8);
    expect(afterVariant!.reserved).toBe(0);
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe(ReservationStatus.Committed);
  });

  it("dedupes redelivery of the same event id: 200 without double-committing stock", async () => {
    const { order, variant } = await checkout("mpwh-dupe-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({
      status: PaymentStatus.Paid,
      orderId: order.id,
    });
    const event = paymentEvent(order.payment.ref!);

    const first = await post(event, "valid", order.payment.ref!);
    const second = await post(event, "valid", order.payment.ref!); // identical event id

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    // Committed exactly once.
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8); // not 6
    expect(await ProcessedWebhookEvent.countDocuments({})).toBe(1);
  });
});

describe("Mercado Pago webhook — refund / failure", () => {
  it("Refunded status marks the order refunded and RESTOCKS onHand", async () => {
    const { order, variant } = await checkout("mpwh-refund-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValueOnce({
      status: PaymentStatus.Paid,
      orderId: order.id,
    });
    await post(paymentEvent(order.payment.ref!), "valid", order.payment.ref!);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(8);

    mercadopagoMock.getPaymentById.mockResolvedValueOnce({
      status: PaymentStatus.Refunded,
      orderId: order.id,
    });
    const res = await post(paymentEvent(order.payment.ref!), "valid", order.payment.ref!);
    expect(res.status).toBe(200);

    const refunded = await Order.findById(order.id);
    expect(refunded!.status).toBe(OrderStatus.Refunded);
    expect((await ProductVariant.findById(variant.id))!.onHand).toBe(10);
    const last = refunded!.statusHistory[refunded!.statusHistory.length - 1]!;
    expect(last.by).toBe("system:mercadopago-webhook");
  });

  it("Failed status is NOT terminal: order stays pending, stock stays reserved (a declined attempt is retryable)", async () => {
    const { order, variant } = await checkout("mpwh-failed-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({
      status: PaymentStatus.Failed,
      orderId: order.id,
    });
    const event = paymentEvent(order.payment.ref!);

    const res = await post(event, "valid", order.payment.ref!);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // No cancellation, no stock release — Checkout Pro lets the buyer retry
    // with another card under the same external_reference.
    const stillPending = await Order.findById(order.id);
    expect(stillPending!.status).toBe(OrderStatus.PendingPayment);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(2);
    expect(afterVariant!.onHand).toBe(10);
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe(ReservationStatus.Active);
    // The event was still processed (deduped), just with no order mutation.
    expect(await ProcessedWebhookEvent.countDocuments({ eventId: event.id })).toBe(1);
  });

  it("regression: a declined attempt followed by a successful retry ends up paid, not stuck cancelled", async () => {
    const { order, variant } = await checkout("mpwh-decline-then-pay-1", 100000, 10, 2);

    // Attempt #1: declined.
    mercadopagoMock.getPaymentById.mockResolvedValueOnce({
      status: PaymentStatus.Failed,
      orderId: order.id,
    });
    const declined = await post(paymentEvent(order.payment.ref!), "valid", order.payment.ref!);
    expect(declined.status).toBe(200);
    const afterDecline = await Order.findById(order.id);
    expect(afterDecline!.status).toBe(OrderStatus.PendingPayment);
    expect((await ProductVariant.findById(variant.id))!.reserved).toBe(2);

    // Attempt #2 (retry, same external_reference / order, different notification): approved.
    mercadopagoMock.getPaymentById.mockResolvedValueOnce({
      status: PaymentStatus.Paid,
      orderId: order.id,
    });
    const approved = await post(paymentEvent(order.payment.ref!), "valid", order.payment.ref!);
    expect(approved.status).toBe(200);

    // The order was never cancelled, so markPaidInternal's legal-transition
    // check succeeds — no "PAGO CAPTURADO sobre orden no pagable" trap.
    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    expect(paid!.payment.status).toBe(PaymentStatus.Paid);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8);
    expect(afterVariant!.reserved).toBe(0);
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe(ReservationStatus.Committed);
  });

  it("Pending status is acknowledged with NO state change", async () => {
    const { order, variant } = await checkout("mpwh-pending-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({
      status: PaymentStatus.Pending,
      orderId: order.id,
    });

    const res = await post(paymentEvent(order.payment.ref!), "valid", order.payment.ref!);
    expect(res.status).toBe(200);

    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.PendingPayment);
    expect((await ProductVariant.findById(variant.id))!.reserved).toBe(2);
  });
});

describe("Mercado Pago webhook — dispatch failure cleans up the dedupe record", () => {
  it("deletes the ProcessedWebhookEvent on a dispatch failure so a genuine retry is NOT deduped", async () => {
    const { order } = await checkout("mpwh-dispatch-fail-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({
      status: PaymentStatus.Paid,
      orderId: order.id,
    });
    const event = paymentEvent(order.payment.ref!);

    const failure = new Error("Simulated downstream failure");
    const spy = vi.spyOn(orderService, "markPaidByPaymentRef").mockRejectedValueOnce(failure);

    const first = await post(event, "valid", order.payment.ref!);
    expect(first.status).toBe(500);
    expect(await ProcessedWebhookEvent.countDocuments({ eventId: event.id })).toBe(0);
    const stillPending = await Order.findById(order.id);
    expect(stillPending!.status).toBe(OrderStatus.PendingPayment);

    spy.mockRestore();

    const second = await post(event, "valid", order.payment.ref!);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBeUndefined();
    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    expect(await ProcessedWebhookEvent.countDocuments({ eventId: event.id })).toBe(1);
  });
});

describe("Mercado Pago webhook — uncorrelatable payment", () => {
  it("acknowledges (200) without mutation when getPaymentById returns no orderId", async () => {
    const { order } = await checkout("mpwh-nocorrelate-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({ status: PaymentStatus.Paid, orderId: "" });

    const res = await post(paymentEvent("some-unrelated-payment-id"), "valid", "some-unrelated-payment-id");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.PendingPayment);
  });
});

describe("Mercado Pago webhook — empty payment id", () => {
  it("acknowledges (200) without calling getPaymentById when the resolved data.id is empty", async () => {
    const { order } = await checkout("mpwh-emptyid-1", 100000, 10, 2);

    // dataId "" resolves through the SAME path as a real notification whose
    // `data.id` cannot be determined: neither the query nor the body carries
    // a usable id, so `constructWebhookEvent`'s meta.dataId ends up "".
    const res = await post(paymentEvent(""), "valid", "");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mercadopagoMock.getPaymentById).not.toHaveBeenCalled();

    const after = await Order.findById(order.id);
    expect(after!.status).toBe(OrderStatus.PendingPayment);
  });
});

describe("Mercado Pago webhook — non-payment topics", () => {
  it("acknowledges a merchant_order (non-payment) notification without deduping or calling orderService", async () => {
    const event = {
      id: `notif_${(eventSeq += 1)}`,
      type: "merchant_order",
      data: { id: "mo_123" },
    };
    const res = await post(event, "valid");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, ignored: true });
    expect(await ProcessedWebhookEvent.countDocuments({ eventId: event.id })).toBe(0);
    expect(mercadopagoMock.getPaymentById).not.toHaveBeenCalled();
  });
});

describe("Mercado Pago webhook — data.id resolution", () => {
  it("falls back to the raw body's data.id when the query string omits it", async () => {
    const { order, variant } = await checkout("mpwh-body-dataid-1", 100000, 10, 2);
    mercadopagoMock.getPaymentById.mockResolvedValue({
      status: PaymentStatus.Paid,
      orderId: order.id,
    });

    // No third arg to post(): the query string carries no `data.id` at all,
    // so the controller must fall back to parsing it out of the raw request
    // body (MP's real wire format: `{ ..., data: { id: <paymentId> } }`).
    const event = paymentEvent(order.payment.ref!);
    const res = await post(event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // The mock's constructWebhookEvent stamps `data.object.id` from
    // `meta.dataId` — proving the controller resolved it from the body.
    expect(mercadopagoMock.constructWebhookEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      "valid",
      expect.objectContaining({ dataId: order.payment.ref }),
    );
    expect(mercadopagoMock.getPaymentById).toHaveBeenCalledWith(order.payment.ref);

    const paid = await Order.findById(order.id);
    expect(paid!.status).toBe(OrderStatus.Paid);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.onHand).toBe(8);
  });
});
