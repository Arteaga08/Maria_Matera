import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";

/**
 * Coupon CRUD + public validation (sub-step 2c).
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const ADMIN_PASSWORD = "AdminPass123";
const DAY = 24 * 60 * 60 * 1000;

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

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("Coupons 2c", () => {
  it("creates a coupon and previews the discount publicly", async () => {
    const agent = await adminAgent();
    const created = await agent.post("/api/v1/admin/coupons").send({
      code: "welcome10",
      type: "percent",
      value: 10,
      validFrom: iso(-DAY),
      validTo: iso(DAY),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.coupon.code).toBe("WELCOME10");

    const preview = await request(app)
      .post("/api/v1/coupons/validate")
      .send({ code: "WELCOME10", subtotalCents: 100000 });
    expect(preview.status).toBe(200);
    expect(preview.body.data.coupon.discountCents).toBe(10000);
  });

  it("rejects an expired coupon", async () => {
    const agent = await adminAgent();
    await agent.post("/api/v1/admin/coupons").send({
      code: "OLD20",
      type: "fixed",
      value: 5000,
      validFrom: iso(-2 * DAY),
      validTo: iso(-DAY),
    });
    const res = await request(app).post("/api/v1/coupons/validate").send({ code: "OLD20" });
    expect(res.status).toBe(400);
  });

  it("keeps VIP-only coupons out of the public preview (403)", async () => {
    const agent = await adminAgent();
    await agent.post("/api/v1/admin/coupons").send({
      code: "VIPONLY",
      type: "percent",
      value: 25,
      validFrom: iso(-DAY),
      validTo: iso(DAY),
      isVipOnly: true,
    });
    const res = await request(app).post("/api/v1/coupons/validate").send({ code: "VIPONLY" });
    expect(res.status).toBe(403);
  });

  it("rejects a duplicate coupon code (409)", async () => {
    const agent = await adminAgent();
    const body = {
      code: "DUP",
      type: "percent",
      value: 5,
      validFrom: iso(-DAY),
      validTo: iso(DAY),
    };
    await agent.post("/api/v1/admin/coupons").send(body);
    const dup = await agent.post("/api/v1/admin/coupons").send(body);
    expect(dup.status).toBe(409);
  });

  it("blocks coupon creation without an admin session (401)", async () => {
    const res = await request(app).post("/api/v1/admin/coupons").send({
      code: "NOPE",
      type: "percent",
      value: 10,
      validFrom: iso(-DAY),
      validTo: iso(DAY),
    });
    expect(res.status).toBe(401);
  });
});
