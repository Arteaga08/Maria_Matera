import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AdminRole, SubscriberStatus } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Subscriber } from "../../src/models/Subscriber.js";
import { emailService } from "../../src/services/email.service.js";

/**
 * Newsletter marketing (sub-step 2d): double opt-in, one-click unsubscribe, and
 * broadcasting a coupon only to confirmed subscribers.
 */

// A real listening server (not the bare Express app) held open for the whole
// file — see `address.test.ts` for why: supertest otherwise spins up its OWN
// ephemeral `http.Server` per request, and that churn under full-suite
// concurrency is a known source of a rare port-reuse parse-error flake.
const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
const ADMIN_PASSWORD = "AdminPass123";
const DAY = 24 * 60 * 60 * 1000;

const tokenFromUrl = (url: string): string => new URL(url).searchParams.get("token") ?? "";

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

const subscribeAndConfirm = async (email: string) => {
  let confirmUrl = "";
  const spy = vi
    .spyOn(emailService, "sendSubscriptionConfirmation")
    .mockImplementation(async (_to, url) => {
      confirmUrl = url;
    });
  await request(app).post("/api/v1/newsletter/subscribe").send({ email, consent: true });
  await request(app).get(`/api/v1/newsletter/confirm?token=${tokenFromUrl(confirmUrl)}`);
  spy.mockRestore();
};

describe("Newsletter 2d", () => {
  it("subscribes with double opt-in and confirms", async () => {
    await subscribeAndConfirm("fan@test.com");
    const subscriber = await Subscriber.findOne({ email: "fan@test.com" });
    expect(subscriber!.status).toBe(SubscriberStatus.Subscribed);
  });

  it("unsubscribes via the one-click link", async () => {
    await subscribeAndConfirm("bye@test.com");
    const subscriber = await Subscriber.findOne({ email: "bye@test.com" }).select(
      "+unsubscribeToken",
    );

    const res = await request(app).get(
      `/api/v1/newsletter/unsubscribe?token=${subscriber!.unsubscribeToken}`,
    );
    expect(res.status).toBe(200);

    const after = await Subscriber.findOne({ email: "bye@test.com" });
    expect(after!.status).toBe(SubscriberStatus.Unsubscribed);
  });

  it("broadcasts a coupon only to confirmed subscribers", async () => {
    const agent = await adminAgent();
    const coupon = await agent.post("/api/v1/admin/coupons").send({
      code: "NEWS15",
      type: "percent",
      value: 15,
      validFrom: new Date(Date.now() - DAY).toISOString(),
      validTo: new Date(Date.now() + DAY).toISOString(),
    });
    const couponId = coupon.body.data.coupon.id ?? coupon.body.data.coupon._id;

    await subscribeAndConfirm("confirmed@test.com");
    // A pending (unconfirmed) subscriber must NOT receive the broadcast.
    const pendingSpy = vi
      .spyOn(emailService, "sendSubscriptionConfirmation")
      .mockResolvedValue();
    await request(app).post("/api/v1/newsletter/subscribe").send({ email: "pending@test.com" });
    pendingSpy.mockRestore();

    const couponSpy = vi.spyOn(emailService, "sendCouponEmail").mockResolvedValue();
    const res = await agent.post(`/api/v1/admin/marketing/broadcast/${couponId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(1);
    expect(couponSpy).toHaveBeenCalledTimes(1);
    couponSpy.mockRestore();
  });
});
