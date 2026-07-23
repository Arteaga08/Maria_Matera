import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import {
  AdminRole,
  CouponType,
  OrderStatus,
  PaymentProvider,
  SubscriberStatus,
} from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Coupon } from "../../src/models/Coupon.js";
import { CouponRedemption } from "../../src/models/CouponRedemption.js";
import { Order } from "../../src/models/Order.js";
import { Subscriber } from "../../src/models/Subscriber.js";
import * as couponService from "../../src/services/coupon.service.js";
import * as subscriberService from "../../src/services/subscriber.service.js";

/**
 * Promotions/Email admin panel (Bloque 2, dashboard): paginated coupon list
 * with computed status, per-coupon performance (redemptions + realized
 * revenue vs. discount cost) and newsletter subscriber stats. The coupon CRUD
 * and broadcast stay covered by their own test files.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

const makeCoupon = (overrides: Record<string, unknown> = {}) => {
  counter += 1;
  return Coupon.create({
    code: `PANEL${counter}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    type: CouponType.Percent,
    value: 10,
    validFrom: new Date(Date.now() - DAY),
    validTo: new Date(Date.now() + DAY),
    ...overrides,
  });
};

const address = {
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
};

const makeOrderWithCoupon = async (
  couponCode: string,
  overrides: Partial<{ status: OrderStatus; totalCents: number; discountCents: number }> = {},
) => {
  counter += 1;
  return Order.create({
    customerId: new mongoose.Types.ObjectId(),
    orderNumber: `MM-${new mongoose.Types.ObjectId().toHexString().toUpperCase()}`,
    items: [
      {
        productId: new mongoose.Types.ObjectId(),
        variantId: new mongoose.Types.ObjectId(),
        sku: `PANEL-SKU-${counter}`,
        name: "Anillo Panel",
        qty: 1,
        unitPriceCents: overrides.totalCents ?? 100000,
        lineSubtotalCents: overrides.totalCents ?? 100000,
      },
    ],
    shippingAddress: address,
    billingAddress: address,
    subtotalCents: overrides.totalCents ?? 100000,
    shippingCostCents: 0,
    discountCents: overrides.discountCents ?? 10000,
    couponCode,
    totalCents: (overrides.totalCents ?? 100000) - (overrides.discountCents ?? 10000),
    status: overrides.status ?? OrderStatus.Paid,
    payment: { provider: PaymentProvider.Stripe, status: "paid" },
    idempotencyKey: `idem-panel-${counter}`,
    reservationId: new mongoose.Types.ObjectId(),
    reservationExpiresAt: new Date(Date.now() + 60_000),
  });
};

const adminAgent = async () => {
  counter += 1;
  await AdminUser.create({
    username: `panel-admin-${counter}`,
    email: `panel-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `panel-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

describe("Coupon adminList (service, paginated panel)", () => {
  it("paginates and reports meta", async () => {
    await makeCoupon();
    await makeCoupon();
    await makeCoupon();

    const page1 = await couponService.adminList({ page: "1", pageSize: "2" });
    expect(page1.items).toHaveLength(2);
    expect(page1.meta).toMatchObject({ page: 1, pageSize: 2 });
    expect(page1.meta.total).toBeGreaterThanOrEqual(3);
  });

  it("computes status: vigente, expirado and agotado; and filters by it", async () => {
    const vigente = await makeCoupon();
    const expirado = await makeCoupon({
      validFrom: new Date(Date.now() - 10 * DAY),
      validTo: new Date(Date.now() - 5 * DAY),
    });
    const agotado = await makeCoupon({ maxRedemptions: 2, usedCount: 2 });

    const all = await couponService.adminList({});
    const byId = new Map(all.items.map((row) => [row.coupon.id as string, row.computedStatus]));
    expect(byId.get(vigente.id as string)).toBe("vigente");
    expect(byId.get(expirado.id as string)).toBe("expirado");
    expect(byId.get(agotado.id as string)).toBe("agotado");

    const expirados = await couponService.adminList({ status: "expirado" });
    expect(expirados.items.map((r) => r.coupon.id)).toEqual([expirado.id]);
  });

  it("filters by isActive and isVipOnly, and searches by code", async () => {
    const inactive = await makeCoupon({ isActive: false });
    const vip = await makeCoupon({ isVipOnly: true });
    const searchable = await makeCoupon({ code: "BUSCAPANEL99" });

    const inactives = await couponService.adminList({ isActive: "false" });
    expect(inactives.items.map((r) => r.coupon.id)).toContain(inactive.id);
    expect(inactives.items.every((r) => !r.coupon.isActive)).toBe(true);

    const vips = await couponService.adminList({ isVipOnly: "true" });
    expect(vips.items.map((r) => r.coupon.id)).toEqual([vip.id]);

    const found = await couponService.adminList({ search: "BUSCAPANEL" });
    expect(found.items.map((r) => r.coupon.id)).toEqual([searchable.id]);
  });
});

describe("Coupon adminPerformance (service)", () => {
  it("reports redemptions and realized revenue vs discount cost", async () => {
    const coupon = await makeCoupon();
    const customerA = new mongoose.Types.ObjectId();
    const customerB = new mongoose.Types.ObjectId();
    await CouponRedemption.create({ couponId: coupon._id, customerId: customerA });
    await CouponRedemption.create({ couponId: coupon._id, customerId: customerB });

    await makeOrderWithCoupon(coupon.code, { totalCents: 200000, discountCents: 20000 });
    await makeOrderWithCoupon(coupon.code, {
      totalCents: 100000,
      discountCents: 10000,
      status: OrderStatus.Delivered,
    });
    // Never counted: refunded and pending.
    await makeOrderWithCoupon(coupon.code, { status: OrderStatus.Refunded });
    await makeOrderWithCoupon(coupon.code, { status: OrderStatus.PendingPayment });

    const perf = await couponService.adminPerformance(coupon.id as string);

    expect(perf.redemptions.total).toBe(2);
    expect(perf.orders.count).toBe(2);
    // (200000-20000) + (100000-10000) = 270000 revenue; 30000 discount cost.
    expect(perf.orders.revenueCents).toBe(270000);
    expect(perf.orders.discountCents).toBe(30000);
  });

  it("throws 404 for a non-existent coupon", async () => {
    await expect(
      couponService.adminPerformance(new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Subscriber adminStats (service)", () => {
  it("counts confirmed subscribers and new-in-range", async () => {
    counter += 1;
    await Subscriber.create({
      email: `subs-${counter}-a@test.com`,
      status: SubscriberStatus.Subscribed,
      consent: true,
      unsubscribeToken: `tok-${counter}-a`,
    });
    counter += 1;
    const old = await Subscriber.create({
      email: `subs-${counter}-b@test.com`,
      status: SubscriberStatus.Subscribed,
      consent: true,
      unsubscribeToken: `tok-${counter}-b`,
    });
    await Subscriber.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date("2026-01-15") } },
    );
    counter += 1;
    await Subscriber.create({
      email: `subs-${counter}-c@test.com`,
      status: SubscriberStatus.Pending,
      consent: true,
      unsubscribeToken: `tok-${counter}-c`,
    });

    const stats = await subscriberService.adminStats({ from: "2026-01-01", to: "2026-01-31" });

    expect(stats.totalSubscribed).toBe(2);
    expect(stats.newInRange).toBe(1);
  });

  it("rejects an invalid range (400)", async () => {
    await expect(
      subscriberService.adminStats({ from: "2026-05-01", to: "2026-01-01" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("Promotions panel HTTP routes", () => {
  it("serves the paginated coupon list with meta and computed status", async () => {
    await makeCoupon();
    const admin = await adminAgent();

    const res = await admin.get("/api/v1/admin/coupons");
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.items[0]).toHaveProperty("computedStatus");
    expect(res.body.meta).toMatchObject({ page: 1 });
  });

  it("serves coupon performance and blocks anonymous (401)", async () => {
    const coupon = await makeCoupon();

    const anon = await request(app).get(
      `/api/v1/admin/coupons/${coupon.id as string}/performance`,
    );
    expect(anon.status).toBe(401);

    const admin = await adminAgent();
    const res = await admin.get(`/api/v1/admin/coupons/${coupon.id as string}/performance`);
    expect(res.status).toBe(200);
    expect(res.body.data.performance).toHaveProperty("redemptions");
    expect(res.body.data.performance).toHaveProperty("orders");
  });

  it("serves marketing stats", async () => {
    const admin = await adminAgent();
    const res = await admin.get("/api/v1/admin/marketing/stats");
    expect(res.status).toBe(200);
    expect(res.body.data.stats).toHaveProperty("totalSubscribed");
  });
});
