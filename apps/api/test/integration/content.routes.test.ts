import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Product } from "../../src/models/Product.js";

/**
 * Home content routes (content editor subsystem). Public storefront read at
 * `GET /content/home` (no auth); per-section admin PUTs under
 * `/admin/content/home/*` open to BOTH roles — editing storefront content is
 * the reason the Editor role exists.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const agentWithRole = async (role: AdminRole) => {
  counter += 1;
  await AdminUser.create({
    username: `content-admin-${counter}`,
    email: `content-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `content-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

const makeProduct = async () => {
  counter += 1;
  return Product.create({
    name: `Pieza ruta ${counter}`,
    slug: `pieza-ruta-${counter}`,
    description: "Joya de prueba",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 250000,
    isPublished: true,
  });
};

describe("GET /api/v1/content/home (public)", () => {
  it("responds 200 without auth with the stable four-key shape", async () => {
    const res = await request(app).get("/api/v1/content/home");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("hero");
    expect(res.body.data).toHaveProperty("newArrivals");
    expect(res.body.data).toHaveProperty("bestSellers");
    expect(res.body.data).toHaveProperty("announcement");
  });
});

describe("admin content endpoints", () => {
  it("returns 401 without an admin session", async () => {
    const get = await request(app).get("/api/v1/admin/content/home");
    const put = await request(app)
      .put("/api/v1/admin/content/home/announcement")
      .send({ text: "Hola", type: "bar", isActive: true });

    expect(get.status).toBe(401);
    expect(put.status).toBe(401);
  });

  it("lets an Editor update the hero and reflects it on the public read", async () => {
    const agent = await agentWithRole(AdminRole.Editor);

    const put = await agent.put("/api/v1/admin/content/home/hero").send({
      slides: [
        {
          mediaType: "image",
          mediaUrl: "https://res.cloudinary.com/demo/hero.jpg",
          title: "Colección de verano",
        },
      ],
    });
    expect(put.status).toBe(200);

    const publicRes = await request(app).get("/api/v1/content/home");
    expect(publicRes.body.data.hero.slides).toHaveLength(1);
    expect(publicRes.body.data.hero.slides[0].title).toBe("Colección de verano");
  });

  it("lets an Admin curate best sellers and the public read keeps the order", async () => {
    const agent = await agentWithRole(AdminRole.Admin);
    const a = await makeProduct();
    const b = await makeProduct();

    const put = await agent.put("/api/v1/admin/content/home/best-sellers").send({
      productIds: [String(b._id), String(a._id)],
      isActive: true,
    });
    expect(put.status).toBe(200);

    const publicRes = await request(app).get("/api/v1/content/home");
    expect(publicRes.body.data.bestSellers.products.map((p: { slug: string }) => p.slug)).toEqual([
      b.slug,
      a.slug,
    ]);
  });

  it("updates new arrivals and the announcement, and the admin GET returns the full document", async () => {
    const agent = await agentWithRole(AdminRole.Editor);
    const a = await makeProduct();

    await agent
      .put("/api/v1/admin/content/home/new-arrivals")
      .send({ productIds: [String(a._id)], isActive: true });
    await agent
      .put("/api/v1/admin/content/home/announcement")
      .send({ text: "Envío gratis", type: "bar", isActive: true });

    const adminGet = await agent.get("/api/v1/admin/content/home");
    expect(adminGet.status).toBe(200);
    expect(adminGet.body.data.content.newArrivals.productIds).toContain(String(a._id));
    expect(adminGet.body.data.content.announcement.text).toBe("Envío gratis");
  });

  it("returns 400 through the error handler for invalid payloads and unknown products", async () => {
    const agent = await agentWithRole(AdminRole.Admin);

    const badPayload = await agent
      .put("/api/v1/admin/content/home/announcement")
      .send({ text: "", type: "banner", isActive: true });
    const ghostProduct = await agent.put("/api/v1/admin/content/home/new-arrivals").send({
      productIds: [new mongoose.Types.ObjectId().toHexString()],
      isActive: true,
    });

    expect(badPayload.status).toBe(400);
    expect(ghostProduct.status).toBe(400);
    expect(ghostProduct.body.message).toMatch(/productos/);
  });
});
