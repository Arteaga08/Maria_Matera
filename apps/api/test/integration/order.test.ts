import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole, Carrier, OrderStatus, PaymentStatus } from "@maria-matera/shared";

/**
 * The Stripe adapter is mocked so checkout's post-transaction PaymentIntent call
 * (and admin refund's Stripe call) never touch the network; the order/inventory
 * HTTP flow is otherwise exercised for real.
 */
const stripeMock = vi.hoisted(() => {
  let seq = 0;
  return {
    createPaymentIntent: vi.fn(async () => {
      seq += 1;
      return { ref: `pi_http_${seq}`, clientSecret: `cs_http_${seq}` };
    }),
    retrievePaymentIntent: vi.fn(async (ref: string) => ({
      ref,
      status: "requires_payment_method",
      clientSecret: `cs_for_${ref}`,
    })),
    refund: vi.fn(async () => undefined),
    constructWebhookEvent: vi.fn(),
  };
});
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

import { buildApp } from "../../src/app.js";
import { emailService } from "../../src/services/email.service.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Order } from "../../src/models/Order.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import { AuditLog } from "../../src/models/AuditLog.js";

/**
 * Order HTTP routes (Milestone 5, Task 4). Owner endpoints under
 * `/api/v1/orders` (protect + requireCustomer); admin under
 * `/api/v1/admin/orders` (protect + Admin/Editor). Anti-IDOR: a customer only
 * ever reaches their own orders. Mirrors `cart.test.ts` / `address.test.ts`.
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake (the
// exact "Parse Error: Expected HTTP/, RTSP/ or ICE/" observed intermittently
// in this file's owner-reads test).
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
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
  const login = await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
  spy.mockRestore();
  return { agent, customerId: login.body.data.user.id as string };
};

const adminAgent = async () => {
  await AdminUser.create({
    username: `owner-${(counter += 1)}`,
    email: `admin-order-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `admin-order-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

const createProduct = async (priceCents = 100000, onHand = 10) => {
  counter += 1;
  const product = await Product.create({
    name: `Anillo ${counter}`,
    slug: `anillo-http-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-HTTP-${counter}`,
    onHand,
  });
  return { product, variant };
};

/** Full checkout setup: a logged-in customer with a cart line and an address. */
const readyToCheckout = async (email: string, priceCents = 100000, onHand = 10, qty = 2) => {
  const { agent, customerId } = await registerAndLogin(email);
  const { product, variant } = await createProduct(priceCents, onHand);
  await agent
    .post("/api/v1/cart/items")
    .send({ productId: product.id, variantId: variant.id, qty });
  const addr = await agent.post("/api/v1/addresses").send({
    label: "Casa",
    line1: "Av. Reforma 123",
    city: "CDMX",
    state: "CDMX",
    zip: "06600",
  });
  const addressId = addr.body.data.address._id as string;
  return { agent, customerId, product, variant, addressId };
};

describe("Order routes — checkout", () => {
  it("creates an order from the cart (201) with a correct snapshot", async () => {
    const { agent, addressId } = await readyToCheckout("ord1@test.com", 150000, 10, 2);

    const res = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0001",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });

    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe(OrderStatus.PendingPayment);
    expect(order.items).toHaveLength(1);
    expect(order.subtotalCents).toBe(300000);
    expect(order.totalCents).toBe(300000);
    expect(order.payment.status).toBe(PaymentStatus.Pending);
    // Task 5: the PaymentIntent is created post-transaction, so the response now
    // carries the gateway ref plus the client secret for the browser SDK.
    expect(order.payment.ref).toMatch(/^pi_http_/);
    expect(res.body.data.clientSecret).toBeTruthy();
  });

  it("is idempotent over HTTP: the same key returns the same order", async () => {
    const { agent, addressId } = await readyToCheckout("ord2@test.com");

    const body = {
      idempotencyKey: "http-idem-0002",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    };
    const first = await agent.post("/api/v1/orders").send(body);
    const second = await agent.post("/api/v1/orders").send(body);

    expect(first.status).toBe(201);
    expect(second.body.data.order._id).toBe(first.body.data.order._id);
    expect(await Order.countDocuments({})).toBe(1);
  });

  it("rejects checkout with a missing idempotency key (400)", async () => {
    const { agent, addressId } = await readyToCheckout("ord3@test.com");
    const res = await agent
      .post("/api/v1/orders")
      .send({ shippingAddressId: addressId, billingAddressId: addressId });
    expect(res.status).toBe(400);
  });

  it("blocks checkout without authentication (401)", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .send({ idempotencyKey: "http-idem-xxxx", shippingAddressId: "x", billingAddressId: "y" });
    expect(res.status).toBe(401);
  });

  it("accepts recipientName/phone and stores them on shippingAddress only, plus a unique orderNumber and a default shipping subdocument", async () => {
    const { agent, addressId } = await readyToCheckout("ordship1@test.com");

    const res = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0008",
      shippingAddressId: addressId,
      billingAddressId: addressId,
      recipientName: "Ana López",
      phone: "5587654321",
    });

    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.orderNumber).toMatch(/^MM-[0-9A-F]{12}$/);
    expect(order.shippingAddress.recipientName).toBe("Ana López");
    expect(order.shippingAddress.phone).toBe("5587654321");
    expect(order.billingAddress.recipientName).toBeUndefined();
    expect(order.billingAddress.phone).toBeUndefined();
    // Mongoose's default `minimize: true` strips an all-empty embedded
    // subdocument from JSON output, so an unset `shipping` is absent here even
    // though it is always a real subdocument instance in-memory (see the
    // model-level assertion in order.service.test.ts).
    expect(order.shipping ?? {}).toEqual({});
  });
});

describe("Order routes — owner reads (anti-IDOR)", () => {
  it("lists and fetches the owner's own orders, and 404s another customer's order", async () => {
    const { agent: agentA, addressId } = await readyToCheckout("ordowner@test.com");
    const created = await agentA.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0003",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;

    const list = await agentA.get("/api/v1/orders");
    expect(list.status).toBe(200);
    expect(list.body.data.orders).toHaveLength(1);

    const mine = await agentA.get(`/api/v1/orders/${orderId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.order._id).toBe(orderId);

    const { agent: agentB } = await registerAndLogin("ordintruder@test.com");
    const intrude = await agentB.get(`/api/v1/orders/${orderId}`);
    expect(intrude.status).toBe(404);

    const listB = await agentB.get("/api/v1/orders");
    expect(listB.body.data.orders).toHaveLength(0);
  });
});

describe("Order routes — admin", () => {
  it("blocks admin endpoints for customers (403) and anonymous (401)", async () => {
    const { agent } = await registerAndLogin("ordcust@test.com");
    const asCustomer = await agent.get("/api/v1/admin/orders");
    expect(asCustomer.status).toBe(403);

    const anon = await request(app).get("/api/v1/admin/orders");
    expect(anon.status).toBe(401);
  });

  it("lets an admin list and fetch any order", async () => {
    const { agent, addressId } = await readyToCheckout("ordadmin1@test.com");
    const created = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0004",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;

    const admin = await adminAgent();
    const list = await admin.get("/api/v1/admin/orders");
    expect(list.status).toBe(200);
    expect(list.body.data.orders.length).toBeGreaterThanOrEqual(1);

    const one = await admin.get(`/api/v1/admin/orders/${orderId}`);
    expect(one.status).toBe(200);
    expect(one.body.data.order._id).toBe(orderId);
  });

  it("cancels an order via the status endpoint, releasing the reservation, and rejects an illegal jump", async () => {
    const { agent, variant, addressId } = await readyToCheckout("ordadmin2@test.com");
    const created = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0005",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;

    const admin = await adminAgent();

    // Illegal: pending_payment → delivered directly.
    const illegal = await admin
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .send({ status: OrderStatus.Delivered });
    expect(illegal.status).toBe(409);

    // Legal: pending_payment → cancelled (releases reservation).
    const cancelled = await admin
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .send({ status: OrderStatus.Cancelled, reason: "Sin stock" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.order.status).toBe(OrderStatus.Cancelled);

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0);
    const order = await Order.findById(orderId);
    const reservation = await StockReservation.findById(order!.reservationId);
    expect(reservation!.status).toBe("released");

    // The status-change endpoint must audit end-to-end (pre-merge M8 hardening).
    const audit = await AuditLog.findOne({ action: "ADVANCE_ORDER_STATUS", targetId: orderId });
    expect(audit).not.toBeNull();
    expect(audit!.module).toBe("order");
  });

  it("refunds a paid order via the refund endpoint", async () => {
    const { agent, addressId } = await readyToCheckout("ordadmin3@test.com");
    const created = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0006",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;

    // Move to a refundable state directly (markPaid HTTP wiring is Task 5).
    await Order.updateOne(
      { _id: orderId },
      { status: OrderStatus.Paid, "payment.status": PaymentStatus.Paid },
    );

    const admin = await adminAgent();
    const refunded = await admin
      .post(`/api/v1/admin/orders/${orderId}/refund`)
      .send({ reason: "Producto defectuoso" });
    expect(refunded.status).toBe(200);
    expect(refunded.body.data.order.status).toBe(OrderStatus.Refunded);
    expect(refunded.body.data.order.payment.status).toBe(PaymentStatus.Refunded);

    // The refund endpoint must audit end-to-end (pre-merge M8 hardening).
    const audit = await AuditLog.findOne({ action: "REFUND_ORDER", targetId: orderId });
    expect(audit).not.toBeNull();
    expect(audit!.module).toBe("order");
  });

  it("rejects a refund with no reason (400)", async () => {
    const { agent, addressId } = await readyToCheckout("ordadmin4@test.com");
    const created = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0007",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;
    await Order.updateOne({ _id: orderId }, { status: OrderStatus.Paid });

    const admin = await adminAgent();
    const res = await admin.post(`/api/v1/admin/orders/${orderId}/refund`).send({});
    expect(res.status).toBe(400);
  });

  it("reverting a shipped order to processing via the status endpoint clears the shipping data", async () => {
    const { agent, addressId } = await readyToCheckout("ordadmin5@test.com");
    const created = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0008",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;

    // Put the order in `shipped` with real shipment data (markPaid/ship HTTP
    // wiring is out of scope here — set the state directly, like the refund test).
    await Order.updateOne(
      { _id: orderId },
      {
        status: OrderStatus.Shipped,
        "shipping.carrier": Carrier.Dhl,
        "shipping.trackingNumber": "TRACK-HTTP-1",
        "shipping.shippedAt": new Date(),
      },
    );

    const admin = await adminAgent();
    const reverted = await admin
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .send({ status: OrderStatus.Processing, reason: "Guía cancelada" });
    expect(reverted.status).toBe(200);
    expect(reverted.body.data.order.status).toBe(OrderStatus.Processing);

    // Re-fetch from the DB: the stale shipment data must be gone.
    const order = await Order.findById(orderId);
    expect(order!.status).toBe(OrderStatus.Processing);
    expect(order!.shipping.carrier).toBeUndefined();
    expect(order!.shipping.trackingNumber).toBeUndefined();
    expect(order!.shipping.shippedAt).toBeUndefined();
  });

  it("a normal paid → processing transition via the status endpoint still works (no shipping side effects)", async () => {
    const { agent, addressId } = await readyToCheckout("ordadmin6@test.com");
    const created = await agent.post("/api/v1/orders").send({
      idempotencyKey: "http-idem-0009",
      shippingAddressId: addressId,
      billingAddressId: addressId,
    });
    const orderId = created.body.data.order._id as string;
    await Order.updateOne(
      { _id: orderId },
      { status: OrderStatus.Paid, "payment.status": PaymentStatus.Paid },
    );

    const admin = await adminAgent();
    const processing = await admin
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .send({ status: OrderStatus.Processing });
    expect(processing.status).toBe(200);
    expect(processing.body.data.order.status).toBe(OrderStatus.Processing);

    // Shipping was empty before and stays empty (the null patch is a harmless no-op).
    const order = await Order.findById(orderId);
    expect(order!.shipping.carrier).toBeUndefined();
    expect(order!.shipping.trackingNumber).toBeUndefined();
    expect(order!.shipping.shippedAt).toBeUndefined();
  });
});
