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

describe("Admin auth — 2FA rate limiting (pre-merge M8 hardening)", () => {
  // The limiter itself is a no-op outside production (see `rateLimit.ts`), so
  // this cannot assert real throttling — only that wiring `twoFactorLimiter`
  // into the route chain does not break `/2fa/enable` / `/2fa/disable` under
  // repeated hits, mirroring `shipping.routes.test.ts`'s equivalent guard.
  it("does not error under repeated hits on /2fa/enable and /2fa/disable", async () => {
    await AdminUser.create({
      username: "owner-2fa",
      email: "owner-2fa@test.com",
      password: ADMIN_PASSWORD,
      role: AdminRole.Admin,
    });
    const agent = request.agent(app);
    await agent
      .post("/api/v1/admin/auth/login")
      .send({ email: "owner-2fa@test.com", password: ADMIN_PASSWORD });

    for (let i = 0; i < 5; i += 1) {
      const res = await agent.post("/api/v1/admin/auth/2fa/enable").send({ totp: "123456" });
      // No 2FA secret was ever set up, so the codes above are always wrong —
      // the meaningful assertion is that the request reaches the controller
      // (400, a business rejection) rather than being blocked (429) or
      // crashing (5xx) under the new limiter.
      expect(res.status).toBe(400);
    }

    const disable = await agent.post("/api/v1/admin/auth/2fa/disable").send({ totp: "123456" });
    expect(disable.status).toBe(400);
  });
});
