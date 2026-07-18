import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AdminRole } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { emailService } from "../../src/services/email.service.js";

/**
 * Admin auth + authorization boundary: admins can log in and reach protected
 * routes; verified customers are denied admin routes (restrictTo).
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const ADMIN_PASSWORD = "AdminPass123";

const createAdmin = async () => {
  await AdminUser.create({
    username: "owner",
    email: "owner@test.com",
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
};

describe("Admin auth", () => {
  it("logs in an admin and reaches /me", async () => {
    await createAdmin();
    const agent = request.agent(app);

    const login = await agent
      .post("/api/v1/admin/auth/login")
      .send({ email: "owner@test.com", password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe(AdminRole.Admin);

    const me = await agent.get("/api/v1/admin/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("owner@test.com");
  });

  it("denies a customer access to admin routes (403)", async () => {
    // Register + verify a customer, then log in.
    const spy = vi.spyOn(emailService, "sendVerificationEmail").mockResolvedValue();
    const agent = request.agent(app);
    await agent
      .post("/api/v1/auth/register")
      .send({ name: "Cliente", email: "cliente@test.com", password: "Password123" });
    // Verify directly via the model to avoid capturing the token here.
    const { Customer } = await import("../../src/models/Customer.js");
    await Customer.updateOne({ email: "cliente@test.com" }, { emailVerified: true });
    await agent
      .post("/api/v1/auth/login")
      .send({ email: "cliente@test.com", password: "Password123" });
    spy.mockRestore();

    const res = await agent.get("/api/v1/admin/auth/me");
    expect(res.status).toBe(403);
  });
});
