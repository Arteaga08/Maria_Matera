import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole, UserType } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import * as auditService from "../../src/services/audit.service.js";

/**
 * Global audit-log read (Bloque 2, dashboard). Admin-ONLY: the trail exposes
 * every admin's actions and IPs, so Editor gets 403 (same criterion as the
 * VIP-tier change). Read-only — the trail stays append-only.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const makeEntry = async (
  overrides: Partial<{
    actorId: mongoose.Types.ObjectId;
    action: string;
    module: string;
    targetId: string;
    createdAt: Date;
  }> = {},
) => {
  const entry = await AuditLog.create({
    actorId: overrides.actorId ?? new mongoose.Types.ObjectId(),
    actorType: UserType.Admin,
    action: overrides.action ?? "TEST_ACTION",
    module: overrides.module ?? "test-module",
    targetId: overrides.targetId ?? new mongoose.Types.ObjectId().toHexString(),
    before: { value: 1 },
    after: { value: 2 },
    ip: "127.0.0.1",
  });
  if (overrides.createdAt) {
    await AuditLog.collection.updateOne(
      { _id: entry._id },
      { $set: { createdAt: overrides.createdAt } },
    );
  }
  return entry;
};

const agentWithRole = async (role: AdminRole) => {
  counter += 1;
  const admin = await AdminUser.create({
    username: `audit-admin-${counter}`,
    email: `audit-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `audit-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return { agent, admin };
};

describe("Audit adminList (service)", () => {
  it("lists entries newest-first with pagination and resolves the actor's identity", async () => {
    const { admin } = await agentWithRole(AdminRole.Admin);
    await makeEntry({
      actorId: admin._id as mongoose.Types.ObjectId,
      createdAt: new Date("2026-07-01"),
    });
    await makeEntry({ createdAt: new Date("2026-07-10") });
    await makeEntry({ createdAt: new Date("2026-07-05") });

    const result = await auditService.adminList({ page: "1", pageSize: "2" });

    expect(result.meta.total).toBeGreaterThanOrEqual(3);
    expect(result.items).toHaveLength(2);
    const dates = result.items.map((r) => new Date(r.createdAt).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));

    const all = await auditService.adminList({});
    // Disambiguate from the admin login's own audit entry (module "auth",
    // written automatically by the same actor — see auth.audit.test.ts):
    // this test's fixture uses "test-module" and set the ip explicitly.
    const resolved = all.items.find(
      (r) => r.actorUsername === admin.username && r.module === "test-module",
    )!;
    expect(resolved).toBeDefined();
    expect(resolved.actorEmail).toBe(admin.email);
    expect(resolved).toHaveProperty("before");
    expect(resolved).toHaveProperty("after");
    expect(resolved.ip).toBe("127.0.0.1");
  });

  it("filters by module, action, actorId and targetId", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const target = new mongoose.Types.ObjectId().toHexString();
    const wanted = await makeEntry({
      actorId,
      action: "CHANGE_CUSTOMER_TIER",
      module: "crm",
      targetId: target,
    });
    await makeEntry({ action: "ADJUST_STOCK", module: "Inventario" });

    const byModule = await auditService.adminList({ module: "crm" });
    expect(byModule.items.map((r) => r.id)).toEqual([wanted.id]);

    const byAction = await auditService.adminList({ action: "CHANGE_CUSTOMER_TIER" });
    expect(byAction.items.map((r) => r.id)).toEqual([wanted.id]);

    const byActor = await auditService.adminList({ actorId: actorId.toHexString() });
    expect(byActor.items.map((r) => r.id)).toEqual([wanted.id]);

    const byTarget = await auditService.adminList({ targetId: target });
    expect(byTarget.items.map((r) => r.id)).toEqual([wanted.id]);
  });

  it("filters by date range", async () => {
    const inRange = await makeEntry({ createdAt: new Date("2026-02-15") });
    await makeEntry({ createdAt: new Date("2026-05-15") });

    const result = await auditService.adminList({ from: "2026-02-01", to: "2026-02-28" });
    expect(result.items.map((r) => r.id)).toEqual([inRange.id]);
  });
});

describe("Audit admin HTTP routes", () => {
  it("blocks anonymous (401) and Editor (403); serves the list to Admin", async () => {
    await makeEntry();

    const anon = await request(app).get("/api/v1/admin/audit");
    expect(anon.status).toBe(401);

    const { agent: editor } = await agentWithRole(AdminRole.Editor);
    const forbidden = await editor.get("/api/v1/admin/audit");
    expect(forbidden.status).toBe(403);

    const { agent: admin } = await agentWithRole(AdminRole.Admin);
    const res = await admin.get("/api/v1/admin/audit");
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.items[0]).toHaveProperty("action");
    expect(res.body.data.items[0]).toHaveProperty("module");
    expect(res.body.meta).toMatchObject({ page: 1 });
  });
});
