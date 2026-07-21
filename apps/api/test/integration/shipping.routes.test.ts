import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole, Carrier, OrderStatus, PaymentStatus } from "@maria-matera/shared";

/**
 * Shipping HTTP routes (Milestone 7, Task 4). Admin mutations/reads under
 * `/api/v1/admin/shipping` (protect + Admin/Editor); public tracking under
 * `/api/v1/tracking` (rate-limited, anti-enumeration). Mirrors `order.test.ts`
 * / `coupon.test.ts`'s conventions: a real listening server, `adminAgent()`,
 * checkout via HTTP, then fast-forwarding order status with `Order.updateOne`
 * exactly like `order.test.ts`'s refund/revert tests do (HTTP wiring for
 * markPaid/ship is out of this task's scope).
 */
const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(async () => ({ ref: "pi_ship_http", clientSecret: "cs_ship_http" })),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

import { buildApp } from "../../src/app.js";
import { emailService } from "../../src/services/email.service.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Order } from "../../src/models/Order.js";

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
afterEach(() => vi.restoreAllMocks());

const PASSWORD = "Password123";
const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const tokenFromUrl = (url: string): string => new URL(url).searchParams.get("token") ?? "";

const registerAndLogin = async (email: string) => {
  let verifyUrl = "";
  const spy = vi
    .spyOn(emailService, "sendVerificationEmail")
    .mockImplementation(async (_to, url) => {
      verifyUrl = url;
    });
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/register").send({ name: "Cliente", email, password: PASSWORD });
  await agent.post("/api/v1/auth/verify-email").send({ token: tokenFromUrl(verifyUrl) });
  await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
  spy.mockRestore();
  return { agent };
};

const adminAgent = async () => {
  await AdminUser.create({
    username: `owner-${(counter += 1)}`,
    email: `admin-ship-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `admin-ship-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

const createProduct = async () => {
  counter += 1;
  const product = await Product.create({
    name: `Anillo ${counter}`,
    slug: `anillo-ship-http-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 100000,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-SHIP-HTTP-${counter}`,
    onHand: 10,
  });
  return { product, variant };
};

/** Creates a real order via HTTP checkout, returns its id. */
const createOrder = async (email: string) => {
  const { agent } = await registerAndLogin(email);
  const { product, variant } = await createProduct();
  await agent.post("/api/v1/cart/items").send({ productId: product.id, variantId: variant.id, qty: 1 });
  const addr = await agent.post("/api/v1/addresses").send({
    label: "Casa",
    line1: "Av. Reforma 123",
    city: "CDMX",
    state: "CDMX",
    zip: "06600",
  });
  const addressId = addr.body.data.address._id as string;
  const created = await agent.post("/api/v1/orders").send({
    idempotencyKey: `ship-http-${email}`,
    shippingAddressId: addressId,
    billingAddressId: addressId,
  });
  return created.body.data.order._id as string;
};

/** Fast-forwards an order straight to `processing` (bypassing HTTP status wiring). */
const seedProcessingOrderId = async (email: string) => {
  const orderId = await createOrder(email);
  await Order.updateOne(
    { _id: orderId },
    { status: OrderStatus.Processing, "payment.status": PaymentStatus.Paid },
  );
  return orderId;
};

/** Fast-forwards an order straight to `shipped` with real shipment data. */
const seedShippedOrderId = async (email: string, trackingNumber: string) => {
  const orderId = await createOrder(email);
  await Order.updateOne(
    { _id: orderId },
    {
      status: OrderStatus.Shipped,
      "payment.status": PaymentStatus.Paid,
      "shipping.carrier": Carrier.Dhl,
      "shipping.trackingNumber": trackingNumber,
      "shipping.shippedAt": new Date(),
    },
  );
  return orderId;
};

describe("Shipping routes — admin: assign-guide", () => {
  it("assigns a guide and transitions processing → shipped (200)", async () => {
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    const orderId = await seedProcessingOrderId("shipassign1@test.com");
    const admin = await adminAgent();

    const res = await admin.patch(`/api/v1/admin/shipping/${orderId}/assign-guide`).send({
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-HTTP-1",
      reason: "guía generada",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe(OrderStatus.Shipped);
    expect(res.body.data.order.shipping.carrier).toBe(Carrier.Dhl);
    expect(res.body.data.order.shipping.trackingNumber).toBe("TRACK-HTTP-1");
  });

  it("rejects a missing/invalid carrier (400)", async () => {
    const orderId = await seedProcessingOrderId("shipassign2@test.com");
    const admin = await adminAgent();

    const missing = await admin
      .patch(`/api/v1/admin/shipping/${orderId}/assign-guide`)
      .send({ trackingNumber: "TRACK-HTTP-2" });
    expect(missing.status).toBe(400);

    const invalid = await admin
      .patch(`/api/v1/admin/shipping/${orderId}/assign-guide`)
      .send({ carrier: "not-a-carrier", trackingNumber: "TRACK-HTTP-2" });
    expect(invalid.status).toBe(400);
  });

  it("blocks without an admin session (401) and without an admin role (403)", async () => {
    const orderId = await seedProcessingOrderId("shipassign3@test.com");

    const anon = await request(app)
      .patch(`/api/v1/admin/shipping/${orderId}/assign-guide`)
      .send({ carrier: Carrier.Dhl, trackingNumber: "TRACK-HTTP-3" });
    expect(anon.status).toBe(401);

    const { agent: customerAgent } = await registerAndLogin("shipassign4@test.com");
    const asCustomer = await customerAgent
      .patch(`/api/v1/admin/shipping/${orderId}/assign-guide`)
      .send({ carrier: Carrier.Dhl, trackingNumber: "TRACK-HTTP-3" });
    expect(asCustomer.status).toBe(403);
  });
});

describe("Shipping routes — admin: deliver", () => {
  it("marks a shipped order as delivered (200)", async () => {
    const orderId = await seedShippedOrderId("shipdeliver1@test.com", "TRACK-HTTP-DELIVER-1");
    const admin = await adminAgent();

    const res = await admin.patch(`/api/v1/admin/shipping/${orderId}/deliver`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe(OrderStatus.Delivered);
    expect(res.body.data.order.shipping.deliveredAt).toBeTruthy();
  });

  it("blocks without an admin session (401)", async () => {
    const orderId = await seedShippedOrderId("shipdeliver2@test.com", "TRACK-HTTP-DELIVER-2");
    const res = await request(app).patch(`/api/v1/admin/shipping/${orderId}/deliver`).send({});
    expect(res.status).toBe(401);
  });
});

describe("Shipping routes — admin: edit-guide", () => {
  it("corrects a typo'd tracking number (200)", async () => {
    const orderId = await seedShippedOrderId("shipedit1@test.com", "TYPO-HTTP-1");
    const admin = await adminAgent();

    const res = await admin.patch(`/api/v1/admin/shipping/${orderId}/edit-guide`).send({
      trackingNumber: "CORRECT-HTTP-1",
      reason: "corrección de guía",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.order.shipping.trackingNumber).toBe("CORRECT-HTTP-1");
    expect(res.body.data.order.status).toBe(OrderStatus.Shipped);
  });

  it("rejects an empty body — the phantom-audit-prevention guard (400)", async () => {
    const orderId = await seedShippedOrderId("shipedit2@test.com", "TYPO-HTTP-2");
    const admin = await adminAgent();

    const empty = await admin.patch(`/api/v1/admin/shipping/${orderId}/edit-guide`).send({});
    expect(empty.status).toBe(400);
    // Locks in the custom Spanish message so a future refactor that drops the
    // `.or()`/`.messages()` override doesn't silently regress to Joi's default
    // English `object.missing` copy while this test stays green on status alone.
    expect(empty.body.message).toContain("al menos un campo");

    // `reason` alone must NOT satisfy the "at least one shipping field" rule.
    const reasonOnly = await admin
      .patch(`/api/v1/admin/shipping/${orderId}/edit-guide`)
      .send({ reason: "sin cambios reales" });
    expect(reasonOnly.status).toBe(400);
    expect(reasonOnly.body.message).toContain("al menos un campo");

    // Confirm no phantom write happened.
    const order = await Order.findById(orderId);
    expect(order!.shipping.trackingNumber).toBe("TYPO-HTTP-2");
  });
});

describe("Shipping routes — admin: revert", () => {
  it("reverts a shipped order back to processing, clearing shipping data (200)", async () => {
    const orderId = await seedShippedOrderId("shiprevert1@test.com", "TRACK-HTTP-REVERT-1");
    const admin = await adminAgent();

    const res = await admin
      .patch(`/api/v1/admin/shipping/${orderId}/revert`)
      .send({ reason: "guía cancelada por el cliente" });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe(OrderStatus.Processing);

    const order = await Order.findById(orderId);
    expect(order!.shipping.carrier).toBeUndefined();
    expect(order!.shipping.trackingNumber).toBeUndefined();
  });

  it("rejects a missing reason (400)", async () => {
    const orderId = await seedShippedOrderId("shiprevert2@test.com", "TRACK-HTTP-REVERT-2");
    const admin = await adminAgent();

    const res = await admin.patch(`/api/v1/admin/shipping/${orderId}/revert`).send({});
    expect(res.status).toBe(400);
  });
});

describe("Shipping routes — admin: processing", () => {
  it("marks a paid order as processing (200)", async () => {
    const orderId = await createOrder("shipprocessing1@test.com");
    await Order.updateOne(
      { _id: orderId },
      { status: OrderStatus.Paid, "payment.status": PaymentStatus.Paid },
    );
    const admin = await adminAgent();

    const res = await admin
      .patch(`/api/v1/admin/shipping/${orderId}/processing`)
      .send({ reason: "inicio de surtido" });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe(OrderStatus.Processing);
  });
});

describe("Shipping routes — admin: getShipment", () => {
  it("returns the order plus a derived trackingUrl (200)", async () => {
    const orderId = await seedShippedOrderId("shipget1@test.com", "TRACK-HTTP-GET-1");
    const admin = await adminAgent();

    const res = await admin.get(`/api/v1/admin/shipping/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order._id).toBe(orderId);
    expect(res.body.data.trackingUrl).toContain("TRACK-HTTP-GET-1");
  });
});

describe("Shipping routes — public: track", () => {
  it("returns a minimal, PII-free payload for an existing tracking number (200)", async () => {
    const orderId = await seedShippedOrderId("shiptrack1@test.com", "TRACK-HTTP-PUBLIC-1");
    void orderId;

    const res = await request(app).get("/api/v1/tracking/TRACK-HTTP-PUBLIC-1");
    expect(res.status).toBe(200);
    expect(res.body.data.tracking).toMatchObject({
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-HTTP-PUBLIC-1",
      status: OrderStatus.Shipped,
    });
    const keys = Object.keys(res.body.data.tracking);
    expect(keys).not.toContain("customerId");
    expect(keys).not.toContain("orderNumber");
    expect(keys).not.toContain("shippingAddress");
  });

  it("returns a flat 404 for an unknown tracking number (anti-enumeration)", async () => {
    const res = await request(app).get("/api/v1/tracking/DOES-NOT-EXIST-HTTP");
    expect(res.status).toBe(404);
  });

  it("does not error under repeated hits (rate limiter is a no-op outside production)", async () => {
    await seedShippedOrderId("shiptrack2@test.com", "TRACK-HTTP-PUBLIC-2");
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get("/api/v1/tracking/TRACK-HTTP-PUBLIC-2");
      expect(res.status).toBe(200);
    }
  });
});
