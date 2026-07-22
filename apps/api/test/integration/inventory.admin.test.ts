import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole, ReservationStatus } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Category } from "../../src/models/Category.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import * as inventory from "../../src/services/inventory.service.js";

/**
 * Admin inventory view (Bloque 2, dashboard). Service: per-variant operational
 * list (onHand/reserved/available + lowStock flag) and aggregate stats. HTTP:
 * auth-gated under /api/v1/admin/inventory.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const makeProductWithVariant = async (
  overrides: Partial<{
    onHand: number;
    reserved: number;
    isArchived: boolean;
    categoryId: mongoose.Types.ObjectId;
    productName: string;
    sku: string;
  }> = {},
) => {
  counter += 1;
  const product = await Product.create({
    name: overrides.productName ?? `Anillo Inv ${counter}`,
    slug: `anillo-inv-${counter}-${Math.random().toString(36).slice(2, 6)}`,
    description: "Anillo de oro de 18k.",
    categoryId: overrides.categoryId ?? new mongoose.Types.ObjectId(),
    priceCents: 100000,
    images: { cardPrimary: "https://cdn.test/ring.jpg" },
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: overrides.sku ?? `INV-${counter}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    onHand: overrides.onHand ?? 10,
    reserved: overrides.reserved ?? 0,
    isArchived: overrides.isArchived ?? false,
  });
  return { product, variant };
};

const adminAgent = async () => {
  counter += 1;
  await AdminUser.create({
    username: `inv-admin-${counter}`,
    email: `inv-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `inv-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

describe("Inventory adminList (service)", () => {
  it("lists variants with onHand/reserved/available and product info, paginated", async () => {
    const { product, variant } = await makeProductWithVariant({ onHand: 10, reserved: 3 });
    await makeProductWithVariant({ onHand: 8 });

    const result = await inventory.adminList({ page: "1", pageSize: "10" });

    expect(result.meta.total).toBeGreaterThanOrEqual(2);
    const row = result.items.find((r) => r.sku === variant.sku)!;
    expect(row).toBeDefined();
    expect(row.onHand).toBe(10);
    expect(row.reserved).toBe(3);
    expect(row.available).toBe(7);
    expect(row.productName).toBe(product.name);
    expect(row.productImage).toBe("https://cdn.test/ring.jpg");
    expect(row.lowStock).toBe(false);
  });

  it("flags lowStock when available ≤ threshold and filters with lowStock=true", async () => {
    const { variant: low } = await makeProductWithVariant({ onHand: 5, reserved: 1 }); // available 4
    await makeProductWithVariant({ onHand: 50 }); // available 50

    const all = await inventory.adminList({});
    const lowRow = all.items.find((r) => r.sku === low.sku)!;
    expect(lowRow.lowStock).toBe(true);

    const filtered = await inventory.adminList({ lowStock: "true" });
    expect(filtered.items.length).toBeGreaterThanOrEqual(1);
    expect(filtered.items.every((r) => r.available <= inventory.LOW_STOCK_THRESHOLD)).toBe(true);
  });

  it("filters outOfStock=true (available = 0)", async () => {
    const { variant: gone } = await makeProductWithVariant({ onHand: 2, reserved: 2 }); // available 0
    await makeProductWithVariant({ onHand: 9 });

    const result = await inventory.adminList({ outOfStock: "true" });
    expect(result.items.map((r) => r.sku)).toContain(gone.sku);
    expect(result.items.every((r) => r.available === 0)).toBe(true);
  });

  it("excludes archived variants by default and includes them with includeArchived=true", async () => {
    const { variant: archived } = await makeProductWithVariant({ isArchived: true });

    const withoutArchived = await inventory.adminList({});
    expect(withoutArchived.items.map((r) => r.sku)).not.toContain(archived.sku);

    const withArchived = await inventory.adminList({ includeArchived: "true" });
    expect(withArchived.items.map((r) => r.sku)).toContain(archived.sku);
  });

  it("filters by category slug", async () => {
    counter += 1;
    const category = await Category.create({
      name: `Anillos ${counter}`,
      slug: `anillos-inv-${counter}`,
      skuPrefix: `AIN${counter}`,
    });
    const { variant: inCategory } = await makeProductWithVariant({
      categoryId: category._id as mongoose.Types.ObjectId,
    });
    await makeProductWithVariant();

    const result = await inventory.adminList({ category: category.slug });
    expect(result.items.map((r) => r.sku)).toEqual([inCategory.sku]);
  });

  it("searches by SKU and by product name", async () => {
    const { variant } = await makeProductWithVariant({
      sku: "INV-SEARCH-XYZ",
      productName: "Brazalete Búsqueda Especial",
    });
    await makeProductWithVariant();

    const bySku = await inventory.adminList({ search: "SEARCH-XYZ" });
    expect(bySku.items.map((r) => r.sku)).toEqual([variant.sku]);

    const byName = await inventory.adminList({ search: "Búsqueda Especial" });
    expect(byName.items.map((r) => r.sku)).toEqual([variant.sku]);
  });

  it("sorts by available ascending by default (critical stock first)", async () => {
    await makeProductWithVariant({ onHand: 50 });
    await makeProductWithVariant({ onHand: 1 });
    await makeProductWithVariant({ onHand: 20 });

    const result = await inventory.adminList({});
    const availables = result.items.map((r) => r.available);
    expect(availables).toEqual([...availables].sort((a, b) => a - b));
  });
});

describe("Inventory adminStats (service)", () => {
  it("reports totals, low-stock/out-of-stock alerts with SKUs, and active reservations", async () => {
    await makeProductWithVariant({ onHand: 10, reserved: 2 });
    const { variant: low } = await makeProductWithVariant({ onHand: 3 }); // available 3 → low
    const { variant: out } = await makeProductWithVariant({ onHand: 0 }); // available 0 → out
    await makeProductWithVariant({ isArchived: true, onHand: 99 }); // excluded

    await StockReservation.create({
      items: [{ variantId: low._id, qty: 2 }],
      status: ReservationStatus.Active,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await StockReservation.create({
      items: [{ variantId: out._id, qty: 1 }],
      status: ReservationStatus.Released,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const stats = await inventory.adminStats();

    expect(stats.totalVariants).toBe(3);
    expect(stats.totalOnHand).toBe(13);
    expect(stats.totalReserved).toBe(2);
    expect(stats.lowStock.count).toBeGreaterThanOrEqual(2); // low (3) + out (0) both ≤ 5
    expect(stats.lowStock.skus).toContain(low.sku);
    expect(stats.outOfStock.count).toBe(1);
    expect(stats.outOfStock.skus).toEqual([out.sku]);
    expect(stats.activeReservations.count).toBe(1);
    expect(stats.activeReservations.units).toBe(2);
  });
});

describe("Inventory admin HTTP routes", () => {
  it("blocks anonymous (401) and returns the operational list for an admin", async () => {
    const anon = await request(app).get("/api/v1/admin/inventory");
    expect(anon.status).toBe(401);

    await makeProductWithVariant({ onHand: 4 });
    const admin = await adminAgent();

    const res = await admin.get("/api/v1/admin/inventory?lowStock=true");
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.items[0]).toHaveProperty("available");
    expect(res.body.data.items[0]).toHaveProperty("lowStock");
    expect(res.body.meta).toMatchObject({ page: 1 });
  });

  it("returns inventory stats for an admin", async () => {
    await makeProductWithVariant({ onHand: 2 });
    const admin = await adminAgent();

    const res = await admin.get("/api/v1/admin/inventory/stats");
    expect(res.status).toBe(200);
    expect(res.body.data.stats).toHaveProperty("totalVariants");
    expect(res.body.data.stats).toHaveProperty("lowStock");
    expect(res.body.data.stats).toHaveProperty("activeReservations");
  });
});
