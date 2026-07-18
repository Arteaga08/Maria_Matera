import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app.js";
import { emailService } from "../../src/services/email.service.js";

/**
 * Address CRUD for the authenticated customer (Milestone 5, Paso 1). Addresses
 * are embedded in `Customer.addresses` — there is no separate collection, so
 * every endpoint must be scoped by the authenticated customer id (anti-IDOR).
 */

// A real listening server (not the bare Express app) held open for this whole
// file: supertest, given a bare app, spins up + tears down its OWN ephemeral
// `http.Server` on a fresh random port for EVERY single request. Under the
// full suite's concurrency (~16 files x many requests each, all in parallel),
// that churn is a known source of a rare port-reuse race producing a garbled
// "Parse Error: Expected HTTP/, RTSP/ or ICE/" — one stable listener per file
// removes the churn entirely.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const PASSWORD = "Password123";

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

const validAddress = (overrides: Record<string, unknown> = {}) => ({
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
  ...overrides,
});

describe("Addresses", () => {
  it("creates, lists, updates, and deletes an address", async () => {
    const { agent } = await registerAndLogin("addr1@test.com");

    const created = await agent.post("/api/v1/addresses").send(validAddress());
    expect(created.status).toBe(201);
    expect(created.body.data.address.label).toBe("Casa");
    const addressId = created.body.data.address._id as string;

    const listed = await agent.get("/api/v1/addresses");
    expect(listed.status).toBe(200);
    expect(listed.body.data.addresses).toHaveLength(1);

    const updated = await agent
      .patch(`/api/v1/addresses/${addressId}`)
      .send({ city: "Guadalajara" });
    expect(updated.status).toBe(200);
    expect(updated.body.data.address.city).toBe("Guadalajara");

    const removed = await agent.delete(`/api/v1/addresses/${addressId}`);
    expect(removed.status).toBe(200);

    const listedAfter = await agent.get("/api/v1/addresses");
    expect(listedAfter.body.data.addresses).toHaveLength(0);
  });

  it("keeps only one default-shipping address at a time", async () => {
    const { agent } = await registerAndLogin("addr2@test.com");

    const first = await agent
      .post("/api/v1/addresses")
      .send(validAddress({ label: "Primera", isDefaultShipping: true }));
    expect(first.body.data.address.isDefaultShipping).toBe(true);

    const second = await agent
      .post("/api/v1/addresses")
      .send(validAddress({ label: "Segunda", isDefaultShipping: true }));
    expect(second.body.data.address.isDefaultShipping).toBe(true);

    const listed = await agent.get("/api/v1/addresses");
    const flags = listed.body.data.addresses.map((a: { isDefaultShipping: boolean }) => a.isDefaultShipping);
    expect(flags.filter(Boolean)).toHaveLength(1);

    const firstAfter = listed.body.data.addresses.find(
      (a: { label: string }) => a.label === "Primera",
    );
    expect(firstAfter.isDefaultShipping).toBe(false);
  });

  it("keeps default-shipping and default-billing independent of one another", async () => {
    const { agent } = await registerAndLogin("addr3@test.com");

    const created = await agent
      .post("/api/v1/addresses")
      .send(validAddress({ isDefaultShipping: true, isDefaultBilling: true }));
    const addressId = created.body.data.address._id as string;

    await agent.post("/api/v1/addresses").send(validAddress({ label: "Oficina", isDefaultShipping: true }));

    const listed = await agent.get("/api/v1/addresses");
    const firstAddr = listed.body.data.addresses.find(
      (a: { _id: string }) => a._id === addressId,
    );
    expect(firstAddr.isDefaultShipping).toBe(false); // unset by the new default-shipping address
    expect(firstAddr.isDefaultBilling).toBe(true); // untouched — independent flag
  });

  it("prevents a customer from reading, updating, or deleting another customer's address (404)", async () => {
    const { agent: agentA } = await registerAndLogin("owner@test.com");
    const { agent: agentB } = await registerAndLogin("intruder@test.com");

    const created = await agentA.post("/api/v1/addresses").send(validAddress());
    const addressId = created.body.data.address._id as string;

    const updateRes = await agentB
      .patch(`/api/v1/addresses/${addressId}`)
      .send({ city: "Hackeado" });
    expect(updateRes.status).toBe(404);

    const delRes = await agentB.delete(`/api/v1/addresses/${addressId}`);
    expect(delRes.status).toBe(404);

    // Customer B's own list must stay empty — no leakage of the other customer's data.
    const listB = await agentB.get("/api/v1/addresses");
    expect(listB.body.data.addresses).toHaveLength(0);

    // Owner's address must be untouched.
    const listA = await agentA.get("/api/v1/addresses");
    expect(listA.body.data.addresses[0].city).toBe("CDMX");
  });

  it("blocks every endpoint without authentication (401)", async () => {
    const res = await request(app).get("/api/v1/addresses");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid MX postal code", async () => {
    const { agent } = await registerAndLogin("addr4@test.com");
    const res = await agent.post("/api/v1/addresses").send(validAddress({ zip: "123" }));
    expect(res.status).toBe(400);
  });

  it("rejects creation with missing required fields", async () => {
    const { agent } = await registerAndLogin("addr5@test.com");
    const res = await agent.post("/api/v1/addresses").send({ label: "Casa" });
    expect(res.status).toBe(400);
  });

  it("accepts optional CFDI fields", async () => {
    const { agent } = await registerAndLogin("addr6@test.com");
    const res = await agent.post("/api/v1/addresses").send(
      validAddress({ rfc: "XAXX010101000", cfdiUse: "G03", taxRegime: "601" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.address.rfc).toBe("XAXX010101000");
  });
});
