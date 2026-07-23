import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import {
  AdminRole,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  SubscriberStatus,
} from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Customer } from "../../src/models/Customer.js";
import { Order } from "../../src/models/Order.js";
import { Product } from "../../src/models/Product.js";
import { ProductViewEvent } from "../../src/models/ProductViewEvent.js";
import { Subscriber } from "../../src/models/Subscriber.js";

/**
 * Dashboard overview endpoint. Pure composition over the per-subsystem stats
 * services — these tests only assert the composition rules (single unified
 * window, top-N trims, snapshot passthrough), never the inner stats logic,
 * which each subsystem's own suite already covers.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const agentWithRole = async (role: AdminRole) => {
  counter += 1;
  await AdminUser.create({
    username: `overview-admin-${counter}`,
    email: `overview-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `overview-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

const backdate = async (
  model: { collection: { updateOne: (f: object, u: object) => Promise<unknown> } },
  _id: unknown,
  createdAt: Date,
) => model.collection.updateOne({ _id }, { $set: { createdAt } });

const makeProduct = async () => {
  counter += 1;
  return Product.create({
    name: `Pieza overview ${counter}`,
    slug: `pieza-overview-${counter}`,
    description: "Joya de prueba",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 300000,
    isPublished: true,
  });
};

const makeRealizedOrder = async (
  productId: mongoose.Types.ObjectId,
  totalCents: number,
  createdAt?: Date,
) => {
  counter += 1;
  const address = {
    label: "Casa",
    line1: "Av. Reforma 123",
    city: "CDMX",
    state: "CDMX",
    zip: "06600",
    country: "México",
  };
  const order = await Order.create({
    customerId: new mongoose.Types.ObjectId(),
    orderNumber: `MM-OVERVIEW-${counter}`,
    items: [
      {
        productId,
        variantId: new mongoose.Types.ObjectId(),
        sku: `SKU-OVW-${counter}`,
        name: `Pieza orden ${counter}`,
        qty: 1,
        unitPriceCents: totalCents,
        lineSubtotalCents: totalCents,
      },
    ],
    shippingAddress: address,
    billingAddress: address,
    subtotalCents: totalCents,
    shippingCostCents: 0,
    totalCents,
    status: OrderStatus.Paid,
    payment: { provider: PaymentProvider.Stripe, status: PaymentStatus.Paid, ref: `ovw-${counter}` },
    idempotencyKey: `idem-ovw-${counter}`,
    reservationId: new mongoose.Types.ObjectId(),
    reservationExpiresAt: new Date(Date.now() + 60_000),
  });
  if (createdAt) await backdate(Order, order._id, createdAt);
  return order;
};

const makeCustomer = async (createdAt?: Date) => {
  counter += 1;
  const customer = await Customer.create({
    name: `Cliente overview ${counter}`,
    email: `cliente-ovw-${counter}@test.com`,
    password: "CustomerPass123",
  });
  if (createdAt) await backdate(Customer, customer._id, createdAt);
  return customer;
};

const makeSubscriber = async (createdAt?: Date) => {
  counter += 1;
  const subscriber = await Subscriber.create({
    email: `sub-ovw-${counter}@test.com`,
    status: SubscriberStatus.Subscribed,
    consent: true,
    unsubscribeToken: `tok-ovw-${counter}`,
  });
  if (createdAt) await backdate(Subscriber, subscriber._id, createdAt);
  return subscriber;
};

describe("GET /api/v1/admin/overview", () => {
  it("returns 401 without an admin session", async () => {
    const res = await request(app).get("/api/v1/admin/overview");
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid date range", async () => {
    const agent = await agentWithRole(AdminRole.Admin);

    const inverted = await agent
      .get("/api/v1/admin/overview")
      .query({ from: "2026-05-01", to: "2026-01-01" });
    const garbage = await agent.get("/api/v1/admin/overview").query({ from: "nope" });

    expect(inverted.status).toBe(400);
    expect(garbage.status).toBe(400);
  });

  it("is available to the Editor role and every section shares ONE unified window", async () => {
    await Promise.all([
      Order.deleteMany({}),
      Customer.deleteMany({}),
      Subscriber.deleteMany({}),
      ProductViewEvent.deleteMany({}),
      Product.deleteMany({}),
    ]);

    const product = await makeProduct();
    const outOfRange = new Date("2026-01-15");
    // In range for the explicit window below:
    await makeRealizedOrder(product._id as mongoose.Types.ObjectId, 700000, new Date("2026-07-10"));
    await makeCustomer(new Date("2026-07-11"));
    await makeSubscriber(new Date("2026-07-12"));
    // Out of range — must not count anywhere:
    await makeRealizedOrder(product._id as mongoose.Types.ObjectId, 900000, outOfRange);
    await makeCustomer(outOfRange);
    await makeSubscriber(outOfRange);

    const agent = await agentWithRole(AdminRole.Editor);
    const res = await agent
      .get("/api/v1/admin/overview")
      .query({ from: "2026-07-01", to: "2026-07-20" });

    expect(res.status).toBe(200);
    const stats = res.body.data.stats;

    // One window, everywhere the same.
    expect(new Date(stats.rangeFrom)).toEqual(new Date("2026-07-01"));
    expect(new Date(stats.rangeTo)).toEqual(new Date("2026-07-20"));
    expect(stats.orders.rangeFrom).toBe(stats.rangeFrom);
    expect(stats.customers.rangeFrom).toBe(stats.rangeFrom);
    expect(stats.marketing.rangeFrom).toBe(stats.rangeFrom);

    // Each section counted ONLY the in-range fixture.
    expect(stats.orders.revenueCents).toBe(700000);
    expect(stats.customers.newInRange).toBe(1);
    expect(stats.marketing.newInRange).toBe(1);

    // Inventory rides along as a current-state snapshot.
    expect(stats.inventory).toMatchObject({
      totalVariants: expect.any(Number),
      totalOnHand: expect.any(Number),
      totalReserved: expect.any(Number),
    });
    expect(stats.inventory.lowStock).toHaveProperty("count");
    expect(stats.inventory.outOfStock).toHaveProperty("count");
  });

  it("uses the SAME default window for orders (30d, not orders' own 7d)", async () => {
    const agent = await agentWithRole(AdminRole.Admin);

    const res = await agent.get("/api/v1/admin/overview");

    expect(res.status).toBe(200);
    const stats = res.body.data.stats;
    expect(stats.orders.rangeFrom).toBe(stats.rangeFrom);
    const spanMs = new Date(stats.rangeTo).getTime() - new Date(stats.rangeFrom).getTime();
    expect(spanMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("trims topProducts and desire products to 5 for the summary payload", async () => {
    await Promise.all([
      Order.deleteMany({}),
      ProductViewEvent.deleteMany({}),
      Product.deleteMany({}),
      Customer.deleteMany({}),
    ]);

    const products = await Promise.all(Array.from({ length: 6 }, makeProduct));
    for (const p of products) {
      await makeRealizedOrder(p._id as mongoose.Types.ObjectId, 100000);
      await ProductViewEvent.create({ productId: p._id });
    }

    const agent = await agentWithRole(AdminRole.Admin);
    const res = await agent.get("/api/v1/admin/overview");

    expect(res.status).toBe(200);
    const stats = res.body.data.stats;
    expect(stats.orders.topProducts).toHaveLength(5);
    expect(stats.desire.products).toHaveLength(5);
  });
});
