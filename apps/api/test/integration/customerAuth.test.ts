import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app.js";
import { emailService } from "../../src/services/email.service.js";

/**
 * End-to-end customer auth flow against the real Express app (in-memory Mongo).
 * The dev email service is spied to capture the verification/reset links.
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const PASSWORD = "Password123";

const tokenFromUrl = (url: string): string => new URL(url).searchParams.get("token") ?? "";

const registerAndVerify = async (email: string) => {
  let verifyUrl = "";
  const spy = vi
    .spyOn(emailService, "sendVerificationEmail")
    .mockImplementation(async (_to, url) => {
      verifyUrl = url;
    });
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/register").send({ name: "Maria", email, password: PASSWORD });
  await agent.post("/api/v1/auth/verify-email").send({ token: tokenFromUrl(verifyUrl) });
  spy.mockRestore();
  return agent;
};

describe("Customer auth", () => {
  it("register → verify → login → me → refresh → logout", async () => {
    let verifyUrl = "";
    const spy = vi
      .spyOn(emailService, "sendVerificationEmail")
      .mockImplementation(async (_to, url) => {
        verifyUrl = url;
      });

    const agent = request.agent(app);

    const reg = await agent
      .post("/api/v1/auth/register")
      .send({ name: "Maria", email: "maria@test.com", password: PASSWORD });
    expect(reg.status).toBe(201);
    expect(reg.body.data.customer.emailVerified).toBe(false);

    const ver = await agent
      .post("/api/v1/auth/verify-email")
      .send({ token: tokenFromUrl(verifyUrl) });
    expect(ver.status).toBe(200);

    const login = await agent
      .post("/api/v1/auth/login")
      .send({ email: "maria@test.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"]).toBeDefined();

    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("maria@test.com");

    const refresh = await agent.post("/api/v1/auth/refresh").send();
    expect(refresh.status).toBe(200);

    const meAfter = await agent.get("/api/v1/auth/me");
    expect(meAfter.status).toBe(200);

    const logout = await agent.post("/api/v1/auth/logout").send();
    expect(logout.status).toBe(200);

    spy.mockRestore();
  });

  it("rejects login with wrong password (generic 401)", async () => {
    const agent = await registerAndVerify("wrong@test.com");
    const res = await agent
      .post("/api/v1/auth/login")
      .send({ email: "wrong@test.com", password: "Incorrect999" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Correo o contraseña incorrectos.");
  });

  it("blocks login before email verification (403)", async () => {
    const spy = vi.spyOn(emailService, "sendVerificationEmail").mockResolvedValue();
    const agent = request.agent(app);
    await agent
      .post("/api/v1/auth/register")
      .send({ name: "Sin Verificar", email: "unverified@test.com", password: PASSWORD });
    const res = await agent
      .post("/api/v1/auth/login")
      .send({ email: "unverified@test.com", password: PASSWORD });
    expect(res.status).toBe(403);
    spy.mockRestore();
  });

  it("rejects duplicate registration (409)", async () => {
    const spy = vi.spyOn(emailService, "sendVerificationEmail").mockResolvedValue();
    const agent = request.agent(app);
    const body = { name: "Dup", email: "dup@test.com", password: PASSWORD };
    await agent.post("/api/v1/auth/register").send(body);
    const res = await agent.post("/api/v1/auth/register").send(body);
    expect(res.status).toBe(409);
    spy.mockRestore();
  });

  it("blocks /me without authentication (401)", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("forgot-password responds generically even for unknown email", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "nobody@test.com" });
    expect(res.status).toBe(200);
  });

  it("reset-password updates the password and the old one stops working", async () => {
    const email = "reset@test.com";
    await registerAndVerify(email);

    let resetUrl = "";
    const spy = vi
      .spyOn(emailService, "sendPasswordResetEmail")
      .mockImplementation(async (_to, url) => {
        resetUrl = url;
      });
    await request(app).post("/api/v1/auth/forgot-password").send({ email });

    const newPassword = "BrandNew456";
    const reset = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: tokenFromUrl(resetUrl), password: newPassword });
    expect(reset.status).toBe(200);

    const oldLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);

    spy.mockRestore();
  });
});
