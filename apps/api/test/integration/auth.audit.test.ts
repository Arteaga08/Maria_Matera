import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { authenticator } from "otplib";
import { AdminRole } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { AuditLog } from "../../src/models/AuditLog.js";

/**
 * Hardening — Frente 1: the admin auth surface must leave an audit trail.
 * Successful admin login and every 2FA posture change land in the AuditLog
 * (module "auth"); a failed login must NOT contaminate the trail (no actor).
 * No record may ever contain the TOTP secret.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const PASSWORD = "AdminPass123";
let counter = 0;

const createAdmin = async () => {
  counter += 1;
  const email = `auth-audit-${counter}@test.com`;
  const admin = await AdminUser.create({
    username: `auth-audit-${counter}`,
    email,
    password: PASSWORD,
    role: AdminRole.Admin,
  });
  return { admin, email };
};

const loginAgent = async (email: string) => {
  const agent = request.agent(app);
  await agent.post("/api/v1/admin/auth/login").send({ email, password: PASSWORD });
  return agent;
};

describe("Auth audit — admin login", () => {
  it("records a successful admin login with actor and ip", async () => {
    const { admin, email } = await createAdmin();

    await request(app).post("/api/v1/admin/auth/login").send({ email, password: PASSWORD });

    const entry = await AuditLog.findOne({ module: "auth", action: "ADMIN_LOGIN" }).sort({
      createdAt: -1,
    });
    expect(entry).not.toBeNull();
    expect(String(entry!.actorId)).toBe(String(admin._id));
    expect(entry!.targetId).toBe(String(admin._id));
    expect(entry!.ip).toBeTruthy();
  });

  it("does NOT write an audit entry for a failed login (wrong password)", async () => {
    const { email } = await createAdmin();
    const before = await AuditLog.countDocuments({ module: "auth" });

    const res = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email, password: "WrongPass999" });

    expect(res.status).toBe(401);
    const after = await AuditLog.countDocuments({ module: "auth" });
    expect(after).toBe(before);
  });

  it("does NOT write an audit entry for a login with an unknown email", async () => {
    const before = await AuditLog.countDocuments({ module: "auth" });

    const res = await request(app)
      .post("/api/v1/admin/auth/login")
      .send({ email: "ghost@test.com", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(await AuditLog.countDocuments({ module: "auth" })).toBe(before);
  });
});

describe("Auth audit — 2FA posture changes", () => {
  it("records setup, enable and disable without ever storing the TOTP secret", async () => {
    const { admin, email } = await createAdmin();
    const agent = await loginAgent(email);

    const setup = await agent.post("/api/v1/admin/auth/2fa/setup").send();
    const secret = setup.body.data.secret as string;

    await agent
      .post("/api/v1/admin/auth/2fa/enable")
      .send({ totp: authenticator.generate(secret) });
    await agent
      .post("/api/v1/admin/auth/2fa/disable")
      .send({ totp: authenticator.generate(secret) });

    const actions = await AuditLog.find({
      module: "auth",
      action: { $in: ["SETUP_2FA", "ENABLE_2FA", "DISABLE_2FA"] },
      actorId: admin._id,
    }).lean();

    const seen = actions.map((a) => a.action);
    expect(seen).toContain("SETUP_2FA");
    expect(seen).toContain("ENABLE_2FA");
    expect(seen).toContain("DISABLE_2FA");

    // The TOTP secret must never appear anywhere in the audit payloads.
    const serialized = JSON.stringify(actions);
    expect(serialized).not.toContain(secret);
  });
});
