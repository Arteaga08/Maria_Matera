import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole, OrderStatus, PaymentProvider, PaymentStatus } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Customer } from "../../src/models/Customer.js";
import { Order } from "../../src/models/Order.js";
import { Product } from "../../src/models/Product.js";
import { ProductViewEvent } from "../../src/models/ProductViewEvent.js";

/**
 * Desire analysis subsystem: anonymous product-view ingest (public, silent on
 * unknown/unsellable products so the endpoint can't be used to enumerate the
 * catalog) + the admin views/wishlist/purchases cross analysis.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const adminAgent = async () => {
  counter += 1;
  await AdminUser.create({
    username: `desire-admin-${counter}`,
    email: `desire-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `desire-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

const makeProduct = async (
  overrides: Partial<{ isPublished: boolean; isArchived: boolean }> = {},
) => {
  counter += 1;
  return Product.create({
    name: `Pieza deseo ${counter}`,
    slug: `pieza-deseo-${counter}`,
    description: "Joya de prueba",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 500000,
    isPublished: overrides.isPublished ?? true,
    isArchived: overrides.isArchived ?? false,
  });
};

const makeView = async (productId: mongoose.Types.ObjectId, createdAt?: Date) => {
  const event = await ProductViewEvent.create({ productId });
  if (createdAt) {
    // Gotcha: Mongoose updateOne without $set won't override timestamps.
    await ProductViewEvent.collection.updateOne({ _id: event._id }, { $set: { createdAt } });
  }
  return event;
};

const makeCustomer = async (wishlist: mongoose.Types.ObjectId[]) => {
  counter += 1;
  return Customer.create({
    name: `Cliente ${counter}`,
    email: `cliente-deseo-${counter}@test.com`,
    password: "CustomerPass123",
    wishlist,
  });
};

const makeRealizedOrder = async (
  productId: mongoose.Types.ObjectId,
  qty: number,
  status: OrderStatus = OrderStatus.Paid,
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
  return Order.create({
    customerId: new mongoose.Types.ObjectId(),
    orderNumber: `MM-DESIRE-${counter}`,
    items: [
      {
        productId,
        variantId: new mongoose.Types.ObjectId(),
        sku: `SKU-DES-${counter}`,
        name: `Pieza orden ${counter}`,
        qty,
        unitPriceCents: 500000,
        lineSubtotalCents: 500000 * qty,
      },
    ],
    shippingAddress: address,
    billingAddress: address,
    subtotalCents: 500000 * qty,
    shippingCostCents: 0,
    totalCents: 500000 * qty,
    status,
    payment: { provider: PaymentProvider.Stripe, status: PaymentStatus.Paid, ref: `ref-${counter}` },
    idempotencyKey: `idem-desire-${counter}`,
    reservationId: new mongoose.Types.ObjectId(),
    reservationExpiresAt: new Date(Date.now() + 60_000),
  });
};

describe("ProductViewEvent model", () => {
  it("declares the TTL index (90 days on createdAt) and the range compound index", () => {
    const indexes = ProductViewEvent.schema.indexes();

    const ttl = indexes.find(([, options]) => options?.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl![0]).toEqual({ createdAt: 1 });
    expect(ttl![1]!.expireAfterSeconds).toBe(90 * 24 * 60 * 60);

    const compound = indexes.find(
      ([keys]) => keys.productId === 1 && keys.createdAt === 1,
    );
    expect(compound).toBeDefined();
  });
});

describe("POST /api/v1/events/product-view (public ingest)", () => {
  it("records a view for a published product and responds 202", async () => {
    const product = await makeProduct();

    const res = await request(app)
      .post("/api/v1/events/product-view")
      .send({ productId: String(product._id) });

    expect(res.status).toBe(202);
    expect(await ProductViewEvent.countDocuments({ productId: product._id })).toBe(1);
  });

  it("responds 202 WITHOUT persisting for unknown, unpublished or archived products", async () => {
    const unpublished = await makeProduct({ isPublished: false });
    const archived = await makeProduct({ isArchived: true });
    const ghost = new mongoose.Types.ObjectId();

    for (const id of [String(unpublished._id), String(archived._id), ghost.toHexString()]) {
      const res = await request(app).post("/api/v1/events/product-view").send({ productId: id });
      expect(res.status).toBe(202);
    }

    expect(
      await ProductViewEvent.countDocuments({
        productId: { $in: [unpublished._id, archived._id, ghost] },
      }),
    ).toBe(0);
  });

  it("rejects a malformed productId with 400", async () => {
    const res = await request(app)
      .post("/api/v1/events/product-view")
      .send({ productId: "not-an-id" });

    expect(res.status).toBe(400);
  });

  it("strips unknown body fields (mass-assignment guard)", async () => {
    const product = await makeProduct();

    const res = await request(app)
      .post("/api/v1/events/product-view")
      .send({ productId: String(product._id), injected: "x" });

    expect(res.status).toBe(202);
    const event = await ProductViewEvent.findOne({ productId: product._id }).lean();
    expect(event).not.toHaveProperty("injected");
  });
});

describe("GET /api/v1/admin/desire (admin analysis)", () => {
  it("returns 401 without an admin session", async () => {
    const res = await request(app).get("/api/v1/admin/desire");
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid date range", async () => {
    const agent = await adminAgent();
    const res = await agent.get("/api/v1/admin/desire").query({ from: "2026-07-15", to: "2026-07-01" });
    expect(res.status).toBe(400);
  });

  it("crosses views, wishlist and realized purchases per product with the documented rules", async () => {
    // Isolated dataset for deterministic ordering asserts.
    await Promise.all([
      ProductViewEvent.deleteMany({}),
      Order.deleteMany({}),
      Customer.deleteMany({}),
      Product.deleteMany({}),
    ]);

    const hot = await makeProduct(); // many views, wishlist, few sales
    const seller = await makeProduct(); // fewer views, more sales
    const unpublished = await makeProduct({ isPublished: false }); // wishlist only
    const archived = await makeProduct({ isArchived: true }); // must be excluded
    const inert = await makeProduct(); // no signal at all — must not appear

    // Views: 3 in range for hot (plus 1 out of range), 2 for seller, 1 for archived.
    await makeView(hot._id as mongoose.Types.ObjectId);
    await makeView(hot._id as mongoose.Types.ObjectId);
    await makeView(hot._id as mongoose.Types.ObjectId);
    await makeView(hot._id as mongoose.Types.ObjectId, new Date("2026-01-01")); // out of range
    await makeView(seller._id as mongoose.Types.ObjectId);
    await makeView(seller._id as mongoose.Types.ObjectId);
    await makeView(archived._id as mongoose.Types.ObjectId);

    // Wishlist: hot ×2, unpublished ×1.
    await makeCustomer([hot._id as mongoose.Types.ObjectId]);
    await makeCustomer([hot._id as mongoose.Types.ObjectId, unpublished._id as mongoose.Types.ObjectId]);

    // Sales: seller 3 units realized; hot 1 unit realized + 5 units cancelled (must not count).
    await makeRealizedOrder(seller._id as mongoose.Types.ObjectId, 3);
    await makeRealizedOrder(hot._id as mongoose.Types.ObjectId, 1);
    await makeRealizedOrder(hot._id as mongoose.Types.ObjectId, 5, OrderStatus.Cancelled);

    const agent = await adminAgent();
    const res = await agent.get("/api/v1/admin/desire");

    expect(res.status).toBe(200);
    const { products, rangeFrom, rangeTo } = res.body.data;
    expect(rangeFrom).toBeDefined();
    expect(rangeTo).toBeDefined();

    const ids = products.map((p: { productId: string }) => p.productId);
    expect(ids).not.toContain(String(archived._id));
    expect(ids).not.toContain(String(inert._id));

    // Order: views desc → hot (3), seller (2), unpublished (0 views, wishlist signal).
    expect(ids).toEqual([String(hot._id), String(seller._id), String(unpublished._id)]);

    const hotRow = products[0];
    expect(hotRow).toMatchObject({
      views: 3,
      wishlistCount: 2,
      unitsSold: 1,
      revenueCents: 500000,
      isPublished: true,
    });
    expect(hotRow.conversionPercent).toBeCloseTo(33.3, 1);

    const sellerRow = products[1];
    expect(sellerRow).toMatchObject({ views: 2, wishlistCount: 0, unitsSold: 3 });
    expect(sellerRow.revenueCents).toBe(1500000);
    expect(sellerRow.conversionPercent).toBeCloseTo(150, 1);

    const unpublishedRow = products[2];
    expect(unpublishedRow).toMatchObject({
      views: 0,
      wishlistCount: 1,
      unitsSold: 0,
      revenueCents: 0,
      isPublished: false,
      conversionPercent: null,
    });
  });
});
