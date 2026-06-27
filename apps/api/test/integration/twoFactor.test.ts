import { describe, expect, it } from "vitest";
import request from "supertest";
import { authenticator } from "otplib";
import { AdminRole } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";

/**
 * Admin 2FA (TOTP): setup → enable, then login requires the password AND a valid
 * code. The secret is stored encrypted at rest; the test reads it from the
 * setup response to generate codes.
 */

const app = buildApp();
const PASSWORD = "AdminPass123";

const createAdmin = async () => {
  await AdminUser.create({
    username: "owner",
    email: "owner@test.com",
    password: PASSWORD,
    role: AdminRole.Admin,
  });
};

const loginAgent = async () => {
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: "owner@test.com", password: PASSWORD });
  return agent;
};

describe("Admin 2FA", () => {
  it("setup → enable, then login requires a valid TOTP code", async () => {
    await createAdmin();
    const agent = await loginAgent();

    const setup = await agent.post("/api/v1/admin/auth/2fa/setup").send();
    expect(setup.status).toBe(200);
    const secret = setup.body.data.secret as string;
    expect(secret).toBeTruthy();
    expect(setup.body.data.otpauthUrl).toContain("otpauth://");

    const enable = await agent
      .post("/api/v1/admin/auth/2fa/enable")
      .send({ totp: authenticator.generate(secret) });
    expect(enable.status).toBe(200);

    // Password alone is no longer enough.
    const withoutCode = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: "owner@test.com", password: PASSWORD });
    expect(withoutCode.status).toBe(401);

    // Password + valid code works.
    const withCode = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: "owner@test.com", password: PASSWORD, totp: authenticator.generate(secret) });
    expect(withCode.status).toBe(200);
    expect(withCode.headers["set-cookie"]).toBeDefined();
  });

  it("rejects enabling 2FA with an invalid code", async () => {
    await createAdmin();
    const agent = await loginAgent();
    await agent.post("/api/v1/admin/auth/2fa/setup").send();

    const enable = await agent
      .post("/api/v1/admin/auth/2fa/enable")
      .send({ totp: "000000" });
    expect(enable.status).toBe(401);
  });
});
