import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { buildApp } from "../../src/app.js";
import { emailService } from "../../src/services/email.service.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Settings, SETTINGS_ID } from "../../src/models/Settings.js";

/**
 * Cart CRUD + live pricing (Milestone 5, Paso 2). The cart document only ever
 * stores refs + qty — price is never persisted there — so every priced
 * assertion here must match the *live* `Product.priceCents`, never a stored
 * value. Anti-IDOR: every endpoint is scoped to the authenticated customer.
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const PASSWORD = "Password123";
let productCounter = 0;

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

const createProduct = async (
  overrides: Partial<{ priceCents: number; isPublished: boolean; isArchived: boolean }> = {},
) => {
  productCounter += 1;
  const product = await Product.create({
    name: `Anillo ${productCounter}`,
    slug: `anillo-${productCounter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: overrides.priceCents ?? 100000,
    isPublished: overrides.isPublished ?? true,
    isArchived: overrides.isArchived ?? false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-${productCounter.toString().padStart(4, "0")}`,
    onHand: 10,
  });
  return { product, variant };
};

describe("Cart", () => {
  it("adds an item and returns a priced cart computed from live catalog prices", async () => {
    const { agent } = await registerAndLogin("cart1@test.com");
    const { product, variant } = await createProduct({ priceCents: 150000 });

    const added = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 2 });
    expect(added.status).toBe(201);

    const cart = added.body.data.cart;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].name).toBe(product.name);
    expect(cart.items[0].unitPriceCents).toBe(150000);
    expect(cart.items[0].linePriceCents).toBe(300000);
    expect(cart.subtotalCents).toBe(300000);
    // No Settings document yet -> default freeShippingThreshold (0) -> always free.
    expect(cart.shippingCostCents).toBe(0);
    expect(cart.totalCents).toBe(300000);
  });

  it("reflects a live price change made after the item was added (never a stored price)", async () => {
    const { agent } = await registerAndLogin("cart2@test.com");
    const { product, variant } = await createProduct({ priceCents: 100000 });

    await agent.post("/api/v1/cart/items").send({ productId: product.id, variantId: variant.id, qty: 1 });

    await Product.updateOne({ _id: product._id }, { priceCents: 250000 });

    const cart = await agent.get("/api/v1/cart");
    expect(cart.body.data.cart.items[0].unitPriceCents).toBe(250000);
    expect(cart.body.data.cart.subtotalCents).toBe(250000);
  });

  it("increments qty when the same product/variant is added twice", async () => {
    const { agent } = await registerAndLogin("cart3@test.com");
    const { product, variant } = await createProduct({ priceCents: 50000 });

    await agent.post("/api/v1/cart/items").send({ productId: product.id, variantId: variant.id, qty: 1 });
    const second = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 2 });

    expect(second.body.data.cart.items).toHaveLength(1);
    expect(second.body.data.cart.items[0].qty).toBe(3);
  });

  it("computes a flat shipping fee below threshold, and free shipping at/above it", async () => {
    await Settings.create({ _id: SETTINGS_ID, freeShippingThreshold: 500000, shippingFlatFee: 9900 });
    const { agent } = await registerAndLogin("cart4@test.com");
    const { product, variant } = await createProduct({ priceCents: 100000 });

    const below = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 2 }); // 200000 subtotal
    expect(below.body.data.cart.subtotalCents).toBe(200000);
    expect(below.body.data.cart.shippingCostCents).toBe(9900);
    expect(below.body.data.cart.totalCents).toBe(209900);

    const above = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 4 }); // +400000 => 600000 subtotal
    expect(above.body.data.cart.subtotalCents).toBe(600000);
    expect(above.body.data.cart.shippingCostCents).toBe(0);
    expect(above.body.data.cart.totalCents).toBe(600000);
  });

  it("updates an item's quantity", async () => {
    const { agent } = await registerAndLogin("cart5@test.com");
    const { product, variant } = await createProduct({ priceCents: 80000 });

    const added = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 1 });
    const itemId = added.body.data.cart.items[0].itemId;

    const updated = await agent.patch(`/api/v1/cart/items/${itemId}`).send({ qty: 5 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.cart.items[0].qty).toBe(5);
    expect(updated.body.data.cart.subtotalCents).toBe(400000);
  });

  it("removes an item from the cart", async () => {
    const { agent } = await registerAndLogin("cart6@test.com");
    const { product, variant } = await createProduct();

    const added = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 1 });
    const itemId = added.body.data.cart.items[0].itemId;

    const removed = await agent.delete(`/api/v1/cart/items/${itemId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.cart.items).toHaveLength(0);
  });

  it("clears the whole cart", async () => {
    const { agent } = await registerAndLogin("cart7@test.com");
    const { product: p1, variant: v1 } = await createProduct();
    const { product: p2, variant: v2 } = await createProduct();

    await agent.post("/api/v1/cart/items").send({ productId: p1.id, variantId: v1.id, qty: 1 });
    await agent.post("/api/v1/cart/items").send({ productId: p2.id, variantId: v2.id, qty: 1 });

    const cleared = await agent.delete("/api/v1/cart");
    expect(cleared.status).toBe(200);

    const after = await agent.get("/api/v1/cart");
    expect(after.body.data.cart.items).toHaveLength(0);
  });

  it("prevents a customer from seeing or mutating another customer's cart (anti-IDOR)", async () => {
    const { agent: agentA } = await registerAndLogin("cartowner@test.com");
    const { agent: agentB } = await registerAndLogin("cartintruder@test.com");
    const { product, variant } = await createProduct();

    const added = await agentA
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 1 });
    const itemId = added.body.data.cart.items[0].itemId;

    const cartB = await agentB.get("/api/v1/cart");
    expect(cartB.body.data.cart.items).toHaveLength(0);

    const updateRes = await agentB.patch(`/api/v1/cart/items/${itemId}`).send({ qty: 9 });
    expect(updateRes.status).toBe(404);

    const delRes = await agentB.delete(`/api/v1/cart/items/${itemId}`);
    expect(delRes.status).toBe(404);

    const cartA = await agentA.get("/api/v1/cart");
    expect(cartA.body.data.cart.items).toHaveLength(1);
    expect(cartA.body.data.cart.items[0].qty).toBe(1);
  });

  it("rejects adding an unpublished product", async () => {
    const { agent } = await registerAndLogin("cart8@test.com");
    const { product, variant } = await createProduct({ isPublished: false });

    const res = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects adding an archived product", async () => {
    const { agent } = await registerAndLogin("cart9@test.com");
    const { product, variant } = await createProduct({ isArchived: true });

    const res = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects a nonexistent product/variant", async () => {
    const { agent } = await registerAndLogin("cart10@test.com");
    const res = await agent.post("/api/v1/cart/items").send({
      productId: new mongoose.Types.ObjectId().toString(),
      variantId: new mongoose.Types.ObjectId().toString(),
      qty: 1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid quantity (zero, negative, non-integer)", async () => {
    const { agent } = await registerAndLogin("cart11@test.com");
    const { product, variant } = await createProduct();

    const zero = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 0 });
    expect(zero.status).toBe(400);

    const negative = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: -1 });
    expect(negative.status).toBe(400);

    const fraction = await agent
      .post("/api/v1/cart/items")
      .send({ productId: product.id, variantId: variant.id, qty: 1.5 });
    expect(fraction.status).toBe(400);
  });

  it("excludes an item from pricing if its product becomes unpublished after being added", async () => {
    const { agent } = await registerAndLogin("cart12@test.com");
    const { product, variant } = await createProduct({ priceCents: 100000 });

    await agent.post("/api/v1/cart/items").send({ productId: product.id, variantId: variant.id, qty: 1 });
    await Product.updateOne({ _id: product._id }, { isPublished: false });

    const cart = await agent.get("/api/v1/cart");
    expect(cart.body.data.cart.items).toHaveLength(0);
    expect(cart.body.data.cart.subtotalCents).toBe(0);
  });

  it("blocks every endpoint without authentication (401)", async () => {
    const res = await request(app).get("/api/v1/cart");
    expect(res.status).toBe(401);
  });
});
