import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";

/**
 * Catalog CRUD (sub-step 2a): categories with SKU prefix, products with an
 * auto-generated default variant, publish gating, and upload validation.
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const ADMIN_PASSWORD = "AdminPass123";

const adminAgent = async () => {
  await AdminUser.create({
    username: "owner",
    email: "owner@test.com",
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: "owner@test.com", password: ADMIN_PASSWORD });
  return agent;
};

const createCategory = async (agent: ReturnType<typeof request.agent>) => {
  const res = await agent
    .post("/api/v1/admin/categories")
    .send({ name: "Anillos", skuPrefix: "RING" });
  return res.body.data.category;
};

describe("Catalog 2a", () => {
  it("creates a product with an auto-generated default variant SKU", async () => {
    const agent = await adminAgent();
    const category = await createCategory(agent);

    const res = await agent.post("/api/v1/admin/products").send({
      name: "Anillo Solitario",
      description: "Anillo de oro de 18k con diamante.",
      categoryId: category.id ?? category._id,
      priceCents: 1500000,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.variants).toHaveLength(1);
    expect(res.body.data.variants[0].sku).toBe("RING-0001");
  });

  it("increments SKU sequence per category", async () => {
    const agent = await adminAgent();
    const category = await createCategory(agent);
    const categoryId = category.id ?? category._id;

    const product = await agent.post("/api/v1/admin/products").send({
      name: "Anillo Doble",
      description: "Anillo de oro con doble banda.",
      categoryId,
      priceCents: 900000,
    });
    const productId = product.body.data.product.id ?? product.body.data.product._id;

    const variant = await agent.post(`/api/v1/admin/products/${productId}/variants`).send({
      size: "7",
    });
    expect(variant.status).toBe(201);
    expect(variant.body.data.variant.sku).toBe("RING-0002");
  });

  it("hides unpublished products from the public catalog until published", async () => {
    const agent = await adminAgent();
    const category = await createCategory(agent);
    const categoryId = category.id ?? category._id;

    const created = await agent.post("/api/v1/admin/products").send({
      name: "Anillo Eternity",
      description: "Anillo eternity de diamantes.",
      categoryId,
      priceCents: 3000000,
    });
    const product = created.body.data.product;
    const productId = product.id ?? product._id;

    const before = await request(app).get("/api/v1/products");
    expect(before.body.data.products).toHaveLength(0);
    expect(before.body.meta.total).toBe(0);

    await agent.patch(`/api/v1/admin/products/${productId}/publish`).send({ isPublished: true });

    const after = await request(app).get("/api/v1/products?category=anillos");
    expect(after.body.data.products).toHaveLength(1);

    const detail = await request(app).get(`/api/v1/products/${product.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.variants.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks catalog mutations without an admin session (401)", async () => {
    const res = await request(app)
      .post("/api/v1/admin/categories")
      .send({ name: "Aretes", skuPrefix: "EAR" });
    expect(res.status).toBe(401);
  });

  it("rejects a non-image upload via magic-byte check (400)", async () => {
    const agent = await adminAgent();
    const res = await agent
      .post("/api/v1/admin/media")
      .attach("image", Buffer.from("this is not an image"), {
        filename: "fake.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(400);
  });
});
