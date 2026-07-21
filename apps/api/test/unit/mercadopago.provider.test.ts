import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentStatus } from "@maria-matera/shared";
import { AppError } from "../../src/utils/AppError.js";

/**
 * Unit tests (Milestone 6, Task 3) for the Mercado Pago adapter.
 *
 * The `mercadopago` SDK is fully mocked so no network call ever happens; the
 * mock's constructors return objects whose methods are `vi.fn()` spies we drive
 * per test. Webhook signature verification is deliberately NOT stubbed — it runs
 * against Node's real `crypto`, and each test recomputes the expected HMAC with
 * the same secret + manifest, so the security-critical path is exercised for
 * real rather than mocked away.
 */

const mocks = vi.hoisted(() => ({
  preferenceCreate: vi.fn(),
  preferenceSearch: vi.fn(),
  preferenceGet: vi.fn(),
  paymentSearch: vi.fn(),
  paymentGet: vi.fn(),
  refundTotal: vi.fn(),
}));

vi.mock("mercadopago", () => ({
  MercadoPagoConfig: vi.fn().mockImplementation(() => ({})),
  Preference: vi.fn().mockImplementation(() => ({
    create: mocks.preferenceCreate,
    search: mocks.preferenceSearch,
    get: mocks.preferenceGet,
  })),
  Payment: vi.fn().mockImplementation(() => ({
    search: mocks.paymentSearch,
    get: mocks.paymentGet,
  })),
  PaymentRefund: vi.fn().mockImplementation(() => ({
    total: mocks.refundTotal,
  })),
}));

// Import AFTER the mock is registered so the module-level SDK singletons resolve
// to the mocked constructors.
const { mercadopagoProvider } = await import("../../src/services/payment/mercadopago.provider.js");

// The webhook secret set for the test environment (see test/setup.ts).
const WEBHOOK_SECRET = "mp-webhook-secret-placeholder-000000000000";

/** Rebuilds MP's documented manifest and signs it, mirroring the adapter. */
const signWebhook = (dataId: string, requestId: string, ts: string): string => {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hash = crypto.createHmac("sha256", WEBHOOK_SECRET).update(manifest).digest("hex");
  return `ts=${ts},v1=${hash}`;
};

beforeEach(() => {
  mocks.preferenceCreate.mockReset();
  mocks.preferenceSearch.mockReset();
  mocks.preferenceGet.mockReset();
  mocks.paymentSearch.mockReset();
  mocks.paymentGet.mockReset();
  mocks.refundTotal.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mercadopagoProvider.createPaymentIntent", () => {
  it("creates a preference correlated by external_reference and returns { ref: orderId, clientSecret: init_point }", async () => {
    mocks.preferenceCreate.mockResolvedValue({
      id: "pref-999",
      init_point: "https://mp.example/checkout/pref-999",
    });

    const result = await mercadopagoProvider.createPaymentIntent({
      amountCents: 250050,
      currency: "MXN",
      metadata: { orderId: "order-abc" },
      idempotencyKey: "idem-key-1",
    });

    expect(result).toEqual({
      ref: "order-abc",
      clientSecret: "https://mp.example/checkout/pref-999",
    });

    expect(mocks.preferenceCreate).toHaveBeenCalledTimes(1);
    const [arg] = mocks.preferenceCreate.mock.calls[0]!;
    expect(arg.body.external_reference).toBe("order-abc");
    expect(arg.body.metadata).toEqual({ order_id: "order-abc" });
    expect(arg.body.items).toHaveLength(1);
    expect(arg.body.items[0].unit_price).toBe(2500.5);
    expect(arg.body.items[0].currency_id).toBe("MXN");
    expect(arg.body.items[0].quantity).toBe(1);
    expect(arg.body.auto_return).toBe("approved");
    expect(arg.body.back_urls.success).toContain("/checkout/exito");
    expect(arg.requestOptions.idempotencyKey).toBe("idem-key-1");
  });

  it("throws an AppError when orderId metadata is missing", async () => {
    await expect(
      mercadopagoProvider.createPaymentIntent({
        amountCents: 1000,
        currency: "MXN",
        idempotencyKey: "idem-key-2",
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(mocks.preferenceCreate).not.toHaveBeenCalled();
  });

  it("maps an MP API error body (status >= 500) to a 503 AppError", async () => {
    mocks.preferenceCreate.mockRejectedValue({ status: 500, message: "boom" });
    await expect(
      mercadopagoProvider.createPaymentIntent({
        amountCents: 1000,
        currency: "MXN",
        metadata: { orderId: "order-x" },
        idempotencyKey: "idem-key-3",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("mercadopagoProvider.retrievePaymentIntent (toCanonicalStatus)", () => {
  const stubInitPoint = () => {
    mocks.preferenceSearch.mockResolvedValue({ elements: [{ id: "pref-1" }] });
    mocks.preferenceGet.mockResolvedValue({ init_point: "https://mp.example/pref-1" });
  };

  it.each([
    ["approved", PaymentStatus.Paid],
    ["pending", PaymentStatus.Pending],
    ["in_process", PaymentStatus.Pending],
    ["rejected", PaymentStatus.Failed],
    ["cancelled", PaymentStatus.Failed],
    ["refunded", PaymentStatus.Refunded],
    ["charged_back", PaymentStatus.Refunded],
  ])("maps MP status %s to canonical %s", async (mpStatus, expected) => {
    mocks.paymentSearch.mockResolvedValue({ results: [{ id: "p1", status: mpStatus }] });
    stubInitPoint();

    const result = await mercadopagoProvider.retrievePaymentIntent("order-1");
    expect(result.status).toBe(expected);
    expect(result.ref).toBe("order-1");
    expect(result.clientSecret).toBe("https://mp.example/pref-1");
    expect(mocks.paymentSearch).toHaveBeenCalledWith({
      options: { external_reference: "order-1" },
    });
  });

  it("returns Pending when no payment exists yet", async () => {
    mocks.paymentSearch.mockResolvedValue({ results: [] });
    stubInitPoint();

    const result = await mercadopagoProvider.retrievePaymentIntent("order-2");
    expect(result.status).toBe(PaymentStatus.Pending);
  });

  it("omits clientSecret when no preference is found", async () => {
    mocks.paymentSearch.mockResolvedValue({ results: [{ id: "p1", status: "approved" }] });
    mocks.preferenceSearch.mockResolvedValue({ elements: [] });

    const result = await mercadopagoProvider.retrievePaymentIntent("order-3");
    expect(result.clientSecret).toBeUndefined();
    expect(mocks.preferenceGet).not.toHaveBeenCalled();
  });

  it("still returns the correct status when the init_point lookup rejects, instead of throwing (reconcile must not skip the order)", async () => {
    mocks.paymentSearch.mockResolvedValue({ results: [{ id: "p1", status: "approved" }] });
    mocks.preferenceSearch.mockRejectedValue(new Error("transient network error"));

    const result = await mercadopagoProvider.retrievePaymentIntent("order-4");
    expect(result.status).toBe(PaymentStatus.Paid);
    expect(result.ref).toBe("order-4");
    expect(result.clientSecret).toBeUndefined();
  });
});

describe("mercadopagoProvider.refund", () => {
  it("issues a full refund on the approved payment found by external_reference", async () => {
    mocks.paymentSearch.mockResolvedValue({
      results: [
        { id: "p-rejected", status: "rejected" },
        { id: "p-approved", status: "approved" },
      ],
    });
    mocks.refundTotal.mockResolvedValue({ id: 123, status: "approved" });

    await mercadopagoProvider.refund("order-r");
    expect(mocks.refundTotal).toHaveBeenCalledWith({ payment_id: "p-approved" });
  });

  it("throws an AppError when there is no approved payment to refund", async () => {
    mocks.paymentSearch.mockResolvedValue({ results: [{ id: "p1", status: "rejected" }] });
    await expect(mercadopagoProvider.refund("order-r2")).rejects.toBeInstanceOf(AppError);
    expect(mocks.refundTotal).not.toHaveBeenCalled();
  });
});

describe("mercadopagoProvider.getPaymentById", () => {
  it("returns canonical status + external_reference (order id)", async () => {
    mocks.paymentGet.mockResolvedValue({
      id: "pay-1",
      status: "approved",
      external_reference: "order-99",
    });

    const result = await mercadopagoProvider.getPaymentById("pay-1");
    expect(result).toEqual({ status: PaymentStatus.Paid, orderId: "order-99" });
    expect(mocks.paymentGet).toHaveBeenCalledWith({ id: "pay-1" });
  });
});

describe("mercadopagoProvider.constructWebhookEvent (HMAC verification)", () => {
  const dataId = "123456789";
  const requestId = "req-abc";

  it("returns a namespaced event keyed on the per-notification id for a VALID signature", () => {
    const ts = Date.now().toString();
    const signature = signWebhook(dataId, requestId, ts);
    const body = Buffer.from(
      JSON.stringify({ id: 987654, type: "payment", data: { id: dataId } }),
    );

    const event = mercadopagoProvider.constructWebhookEvent(body, signature, {
      requestId,
      dataId,
    });

    // event.id is the per-notification id (dedup key); data.object.id stays the payment id.
    expect(event).toEqual({
      id: "mercadopago:987654",
      type: "payment",
      data: { object: { id: dataId } },
    });
  });

  it("keys the event on the notification id, not the payment id, so status-change notifications for one payment are not deduped as duplicates", () => {
    const ts = Date.now().toString();
    const signature = signWebhook(dataId, requestId, ts);
    // Two notifications for the SAME payment (same data.id) as it transitions
    // pending -> approved: MP gives each a distinct top-level `id`.
    const pending = Buffer.from(
      JSON.stringify({ id: 111, type: "payment", data: { id: dataId } }),
    );
    const approved = Buffer.from(
      JSON.stringify({ id: 222, type: "payment", data: { id: dataId } }),
    );

    const first = mercadopagoProvider.constructWebhookEvent(pending, signature, { requestId, dataId });
    const second = mercadopagoProvider.constructWebhookEvent(approved, signature, { requestId, dataId });

    expect(first.id).toBe("mercadopago:111");
    expect(second.id).toBe("mercadopago:222");
    expect(first.id).not.toBe(second.id);
  });

  it("falls back to the payment id when the body carries no notification id", () => {
    const ts = Date.now().toString();
    const signature = signWebhook(dataId, requestId, ts);
    const body = Buffer.from(JSON.stringify({ type: "payment", data: { id: dataId } }));

    const event = mercadopagoProvider.constructWebhookEvent(body, signature, { requestId, dataId });

    expect(event.id).toBe(`mercadopago:${dataId}`);
  });

  it("throws for an INVALID signature (tampered hash)", () => {
    const ts = Date.now().toString();
    const body = Buffer.from(JSON.stringify({ type: "payment" }));
    const forged = `ts=${ts},v1=${"0".repeat(64)}`;

    expect(() =>
      mercadopagoProvider.constructWebhookEvent(body, forged, { requestId, dataId }),
    ).toThrow(AppError);
  });

  it("throws when the wrong secret was used to sign", () => {
    const ts = Date.now().toString();
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const wrongHash = crypto.createHmac("sha256", "not-the-secret").update(manifest).digest("hex");
    const signature = `ts=${ts},v1=${wrongHash}`;
    const body = Buffer.from(JSON.stringify({ type: "payment" }));

    expect(() =>
      mercadopagoProvider.constructWebhookEvent(body, signature, { requestId, dataId }),
    ).toThrow(AppError);
  });

  it("throws when the x-signature header is missing", () => {
    const body = Buffer.from(JSON.stringify({ type: "payment" }));
    expect(() =>
      mercadopagoProvider.constructWebhookEvent(body, undefined, { requestId, dataId }),
    ).toThrow(AppError);
  });

  it("throws when the signature is malformed (no v1 component)", () => {
    const body = Buffer.from(JSON.stringify({ type: "payment" }));
    expect(() =>
      mercadopagoProvider.constructWebhookEvent(body, "ts=123", { requestId, dataId }),
    ).toThrow(AppError);
  });

  it("throws when the timestamp is outside the replay tolerance", () => {
    const staleTs = (Date.now() - 10 * 60 * 1000).toString();
    const signature = signWebhook(dataId, requestId, staleTs);
    const body = Buffer.from(JSON.stringify({ type: "payment" }));

    expect(() =>
      mercadopagoProvider.constructWebhookEvent(body, signature, { requestId, dataId }),
    ).toThrow(AppError);
  });
});
