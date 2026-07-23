import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import {
  AdminRole,
  CustomerTier,
  OrderStatus,
  PaymentProvider,
} from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { Customer } from "../../src/models/Customer.js";
import { Order } from "../../src/models/Order.js";
import { Product } from "../../src/models/Product.js";
import * as crm from "../../src/services/customer.admin.service.js";

/**
 * Admin CRM (Bloque 2, dashboard). Service: customer list with realized-spend
 * aggregation, 360° detail (orders + wishlist), audited tier change, stats.
 * HTTP: reads for Admin/Editor; tier change Admin-only.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const makeCustomer = async (
  overrides: Partial<{
    name: string;
    tier: CustomerTier;
    emailVerified: boolean;
    marketingConsent: boolean;
    wishlist: mongoose.Types.ObjectId[];
    createdAt: Date;
  }> = {},
) => {
  counter += 1;
  const customer = await Customer.create({
    name: overrides.name ?? `Clienta CRM ${counter}`,
    email: `crm-${counter}@test.com`,
    password: "Password123",
    emailVerified: overrides.emailVerified ?? false,
    tier: overrides.tier ?? CustomerTier.Standard,
    marketingConsent: overrides.marketingConsent ?? false,
    wishlist: overrides.wishlist ?? [],
    addresses: [
      {
        label: "Casa",
        line1: "Av. Reforma 123",
        city: "CDMX",
        state: "CDMX",
        zip: "06600",
        country: "México",
      },
    ],
  });
  if (overrides.createdAt) {
    await Customer.collection.updateOne(
      { _id: customer._id },
      { $set: { createdAt: overrides.createdAt } },
    );
  }
  return customer;
};

const makeOrderFor = async (
  customerId: mongoose.Types.ObjectId,
  overrides: Partial<{ status: OrderStatus; totalCents: number }> = {},
) => {
  counter += 1;
  return Order.create({
    customerId,
    orderNumber: `MM-${new mongoose.Types.ObjectId().toHexString().toUpperCase()}`,
    items: [
      {
        productId: new mongoose.Types.ObjectId(),
        variantId: new mongoose.Types.ObjectId(),
        sku: `CRM-SKU-${counter}`,
        name: "Anillo CRM",
        qty: 1,
        unitPriceCents: overrides.totalCents ?? 100000,
        lineSubtotalCents: overrides.totalCents ?? 100000,
      },
    ],
    shippingAddress: {
      label: "Casa",
      line1: "Av. Reforma 123",
      city: "CDMX",
      state: "CDMX",
      zip: "06600",
      country: "México",
    },
    billingAddress: {
      label: "Casa",
      line1: "Av. Reforma 123",
      city: "CDMX",
      state: "CDMX",
      zip: "06600",
      country: "México",
    },
    subtotalCents: overrides.totalCents ?? 100000,
    shippingCostCents: 0,
    totalCents: overrides.totalCents ?? 100000,
    status: overrides.status ?? OrderStatus.Paid,
    payment: { provider: PaymentProvider.Stripe, status: "pending" },
    idempotencyKey: `idem-crm-${counter}`,
    reservationId: new mongoose.Types.ObjectId(),
    reservationExpiresAt: new Date(Date.now() + 60_000),
  });
};

const agentWithRole = async (role: AdminRole) => {
  counter += 1;
  await AdminUser.create({
    username: `crm-admin-${counter}`,
    email: `crm-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `crm-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

describe("CRM adminList (service)", () => {
  it("lists customers with ordersCount and realized totalSpentCents, paginated", async () => {
    const buyer = await makeCustomer();
    await makeOrderFor(buyer._id as mongoose.Types.ObjectId, { totalCents: 150000 });
    await makeOrderFor(buyer._id as mongoose.Types.ObjectId, {
      totalCents: 50000,
      status: OrderStatus.Delivered,
    });
    // Not realized: refunded and pending never count.
    await makeOrderFor(buyer._id as mongoose.Types.ObjectId, {
      totalCents: 999999,
      status: OrderStatus.Refunded,
    });
    await makeOrderFor(buyer._id as mongoose.Types.ObjectId, {
      totalCents: 999999,
      status: OrderStatus.PendingPayment,
    });
    await makeCustomer(); // no orders

    const result = await crm.adminList({ page: "1", pageSize: "10" });

    expect(result.meta.total).toBeGreaterThanOrEqual(2);
    const row = result.items.find((r) => r.id === (buyer.id as string))!;
    expect(row.ordersCount).toBe(2);
    expect(row.totalSpentCents).toBe(200000);
    expect(row).not.toHaveProperty("password");
  });

  it("filters by tier, emailVerified and marketingConsent", async () => {
    await makeCustomer({ tier: CustomerTier.Vip, emailVerified: true, marketingConsent: true });
    await makeCustomer({ tier: CustomerTier.Standard });

    const vips = await crm.adminList({ tier: CustomerTier.Vip });
    expect(vips.items.length).toBeGreaterThanOrEqual(1);
    expect(vips.items.every((r) => r.tier === CustomerTier.Vip)).toBe(true);

    const verified = await crm.adminList({ emailVerified: "true" });
    expect(verified.items.every((r) => r.emailVerified)).toBe(true);

    const consent = await crm.adminList({ marketingConsent: "true" });
    expect(consent.items.every((r) => r.marketingConsent)).toBe(true);
  });

  it("filters by registration date range and searches by name/email", async () => {
    const old = await makeCustomer({ name: "Antigua Compradora", createdAt: new Date("2025-01-15") });
    await makeCustomer({ name: "Nueva Compradora" });

    const inRange = await crm.adminList({ from: "2025-01-01", to: "2025-01-31" });
    expect(inRange.items.map((r) => r.id)).toEqual([old.id as string]);

    const byName = await crm.adminList({ search: "Antigua Comp" });
    expect(byName.items.map((r) => r.id)).toEqual([old.id as string]);

    const byEmail = await crm.adminList({ search: old.email });
    expect(byEmail.items.map((r) => r.id)).toEqual([old.id as string]);
  });

  it("sorts by totalSpentCents descending", async () => {
    const big = await makeCustomer();
    await makeOrderFor(big._id as mongoose.Types.ObjectId, { totalCents: 500000 });
    const small = await makeCustomer();
    await makeOrderFor(small._id as mongoose.Types.ObjectId, { totalCents: 10000 });

    const result = await crm.adminList({ sort: "-totalSpentCents" });
    const spends = result.items.map((r) => r.totalSpentCents);
    expect(spends).toEqual([...spends].sort((a, b) => b - a));
  });
});

describe("CRM adminGetDetail (service)", () => {
  it("returns profile, orders history, totals and wishlist with product info", async () => {
    counter += 1;
    const product = await Product.create({
      name: "Brazalete Deseado",
      slug: `brazalete-deseado-${counter}`,
      description: "Brazalete de oro con diamantes.",
      categoryId: new mongoose.Types.ObjectId(),
      priceCents: 2500000,
      images: { cardPrimary: "https://cdn.test/brazalete.jpg" },
      isPublished: true,
      isArchived: false,
    });
    const customer = await makeCustomer({
      wishlist: [product._id as mongoose.Types.ObjectId],
    });
    await makeOrderFor(customer._id as mongoose.Types.ObjectId, { totalCents: 300000 });
    await makeOrderFor(customer._id as mongoose.Types.ObjectId, { totalCents: 100000 });

    const detail = await crm.adminGetDetail(customer.id as string);

    expect(detail.customer.name).toBe(customer.name);
    expect(detail.customer).not.toHaveProperty("password");
    expect(detail.customer.addresses).toHaveLength(1);
    expect(detail.orders).toHaveLength(2);
    expect(detail.orders[0]).toHaveProperty("orderNumber");
    expect(detail.totals.ordersCount).toBe(2);
    expect(detail.totals.totalSpentCents).toBe(400000);
    expect(detail.totals.averageTicketCents).toBe(200000);
    expect(detail.wishlist).toHaveLength(1);
    expect(detail.wishlist[0]).toMatchObject({
      name: "Brazalete Deseado",
      image: "https://cdn.test/brazalete.jpg",
    });
  });

  it("throws 404 for a non-existent customer", async () => {
    await expect(
      crm.adminGetDetail(new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("CRM changeTier (service)", () => {
  it("changes the tier and records an audit entry with before/after", async () => {
    const customer = await makeCustomer({ tier: CustomerTier.Standard });

    const updated = await crm.changeTier(customer.id as string, CustomerTier.Vip, {
      id: new mongoose.Types.ObjectId().toHexString(),
    });

    expect(updated.tier).toBe(CustomerTier.Vip);
    const audit = await AuditLog.findOne({
      action: "CHANGE_CUSTOMER_TIER",
      targetId: customer.id as string,
    });
    expect(audit).not.toBeNull();
    expect(audit!.before).toMatchObject({ tier: CustomerTier.Standard });
    expect(audit!.after).toMatchObject({ tier: CustomerTier.Vip });
  });

  it("throws 404 for a non-existent customer", async () => {
    await expect(
      crm.changeTier(new mongoose.Types.ObjectId().toHexString(), CustomerTier.Vip, {
        id: "admin-1",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("CRM adminStats (service)", () => {
  it("reports totals, new-in-range and top customers by realized spend", async () => {
    const vip = await makeCustomer({
      tier: CustomerTier.Vip,
      emailVerified: true,
      marketingConsent: true,
    });
    await makeOrderFor(vip._id as mongoose.Types.ObjectId, { totalCents: 900000 });
    const casual = await makeCustomer({ createdAt: new Date("2026-06-15") });
    await makeOrderFor(casual._id as mongoose.Types.ObjectId, { totalCents: 100000 });

    const stats = await crm.adminStats({ from: "2026-06-01", to: "2026-06-30" });

    expect(stats.totalCustomers).toBe(2);
    expect(stats.vipCount).toBe(1);
    expect(stats.verifiedCount).toBe(1);
    expect(stats.marketingConsentCount).toBe(1);
    expect(stats.newInRange).toBe(1);
    expect(stats.topCustomers[0]).toMatchObject({
      name: vip.name,
      tier: CustomerTier.Vip,
      totalSpentCents: 900000,
      ordersCount: 1,
    });
  });

  it("rejects an invalid date range (400)", async () => {
    await expect(crm.adminStats({ from: "2026-05-01", to: "2026-01-01" })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("CRM admin HTTP routes", () => {
  it("blocks anonymous (401) and serves list/detail/stats to an Editor", async () => {
    const anon = await request(app).get("/api/v1/admin/customers");
    expect(anon.status).toBe(401);

    const customer = await makeCustomer();
    const editor = await agentWithRole(AdminRole.Editor);

    const list = await editor.get("/api/v1/admin/customers");
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(list.body.meta).toMatchObject({ page: 1 });

    const detail = await editor.get(`/api/v1/admin/customers/${customer.id as string}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.customer).toBeDefined();
    expect(detail.body.data.totals).toBeDefined();

    const stats = await editor.get("/api/v1/admin/customers/stats");
    expect(stats.status).toBe(200);
    expect(stats.body.data.stats).toHaveProperty("totalCustomers");
  });

  it("lets an Admin change the tier but forbids an Editor (403)", async () => {
    const customer = await makeCustomer({ tier: CustomerTier.Standard });

    const editor = await agentWithRole(AdminRole.Editor);
    const forbidden = await editor
      .patch(`/api/v1/admin/customers/${customer.id as string}/tier`)
      .send({ tier: CustomerTier.Vip });
    expect(forbidden.status).toBe(403);

    const admin = await agentWithRole(AdminRole.Admin);
    const ok = await admin
      .patch(`/api/v1/admin/customers/${customer.id as string}/tier`)
      .send({ tier: CustomerTier.Vip });
    expect(ok.status).toBe(200);
    expect(ok.body.data.customer.tier).toBe(CustomerTier.Vip);

    const invalid = await admin
      .patch(`/api/v1/admin/customers/${customer.id as string}/tier`)
      .send({ tier: "platinum" });
    expect(invalid.status).toBe(400);
  });
});
