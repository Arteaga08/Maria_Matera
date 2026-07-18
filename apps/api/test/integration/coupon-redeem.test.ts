import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { CouponType, CustomerTier } from "@maria-matera/shared";
import { Coupon } from "../../src/models/Coupon.js";
import { CouponRedemption } from "../../src/models/CouponRedemption.js";
import * as couponService from "../../src/services/coupon.service.js";

/**
 * Coupon atomic redemption (Milestone 5, Task 3). `redeem` is designed to run
 * INSIDE a caller-managed transaction (the future Order-creation transaction),
 * so it never starts/commits its own session — these tests drive it the same
 * way `orderService.createOrder` eventually will: a manually-started
 * `mongoose.startSession()` + `session.withTransaction(...)`, mirroring
 * `inventory.test.ts`'s style for `reserveStock`.
 */

const DAY = 24 * 60 * 60 * 1000;

const makeCoupon = (overrides: Partial<Record<string, unknown>> = {}) =>
  Coupon.create({
    code: `TEST-${Math.random().toString(36).slice(2, 8)}`,
    type: CouponType.Percent,
    value: 10,
    validFrom: new Date(Date.now() - DAY),
    validTo: new Date(Date.now() + DAY),
    ...overrides,
  });

describe("Coupon redeem (Milestone 5, Task 3)", () => {
  it("redeems a coupon and increments usedCount", async () => {
    const coupon = await makeCoupon();
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    const result = await session.withTransaction(async () => {
      return couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard, 100000);
    });
    await session.endSession();

    expect(result!.discountCents).toBe(10000);
    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(1);
    const redemptions = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      customerId,
    });
    expect(redemptions).toBe(1);
  });

  it("rejects redemption once maxRedemptions is reached", async () => {
    const coupon = await makeCoupon({ maxRedemptions: 1, usedCount: 1 });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard)),
    ).rejects.toThrow();
    await session.endSession();

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(1); // unchanged — the increment rolled back
  });

  it("never blocks a coupon with no maxRedemptions set (unlimited)", async () => {
    const coupon = await makeCoupon({ usedCount: 500 }); // no maxRedemptions at all
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    await session.withTransaction(async () => couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard));
    await session.endSession();

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(501);
  });

  it("rejects a second redemption by the same customer once perUserLimit is hit", async () => {
    const coupon = await makeCoupon({ perUserLimit: 1 });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session1 = await mongoose.startSession();
    await session1.withTransaction(async () => couponService.redeem(coupon.code, customerId, session1, CustomerTier.Standard));
    await session1.endSession();

    const session2 = await mongoose.startSession();
    await expect(
      session2.withTransaction(async () => couponService.redeem(coupon.code, customerId, session2, CustomerTier.Standard)),
    ).rejects.toThrow();
    await session2.endSession();

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(1); // only the first redemption stuck
    const redemptions = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      customerId,
    });
    expect(redemptions).toBe(1);
  });

  it("allows exactly N redemptions per customer for perUserLimit: 2, rejecting the N+1th", async () => {
    const coupon = await makeCoupon({ perUserLimit: 2 });
    const customerId = new mongoose.Types.ObjectId().toString();

    for (let i = 0; i < 2; i += 1) {
      const session = await mongoose.startSession();
      await session.withTransaction(async () => couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard));
      await session.endSession();
    }

    const session3 = await mongoose.startSession();
    await expect(
      session3.withTransaction(async () => couponService.redeem(coupon.code, customerId, session3, CustomerTier.Standard)),
    ).rejects.toThrow();
    await session3.endSession();

    const redemptions = await CouponRedemption.countDocuments({ couponId: coupon._id, customerId });
    expect(redemptions).toBe(2);
  });

  it("allows a different customer to redeem a perUserLimit:1 coupon after another customer already did", async () => {
    const coupon = await makeCoupon({ perUserLimit: 1 });
    const customerA = new mongoose.Types.ObjectId().toString();
    const customerB = new mongoose.Types.ObjectId().toString();

    const session1 = await mongoose.startSession();
    await session1.withTransaction(async () => couponService.redeem(coupon.code, customerA, session1, CustomerTier.Standard));
    await session1.endSession();

    const session2 = await mongoose.startSession();
    await session2.withTransaction(async () => couponService.redeem(coupon.code, customerB, session2, CustomerTier.Standard));
    await session2.endSession();

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(2);
  });

  it("rejects redemption of an inactive coupon", async () => {
    const coupon = await makeCoupon({ isActive: false });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard)),
    ).rejects.toThrow();
    await session.endSession();
  });

  it("rejects redemption of an expired coupon", async () => {
    const coupon = await makeCoupon({
      validFrom: new Date(Date.now() - 2 * DAY),
      validTo: new Date(Date.now() - DAY),
    });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard)),
    ).rejects.toThrow();
    await session.endSession();
  });

  it("rejects redemption below the coupon's minimum purchase when subtotal is provided", async () => {
    const coupon = await makeCoupon({ minPurchaseCents: 50000 });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard, 10000)),
    ).rejects.toThrow();
    await session.endSession();

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(0); // rolled back
  });

  it("only lets one of two concurrent same-customer redemptions succeed on a perUserLimit:1 coupon", async () => {
    const coupon = await makeCoupon({ perUserLimit: 1 });
    const customerId = new mongoose.Types.ObjectId().toString();

    const attempt = async () => {
      const session = await mongoose.startSession();
      try {
        return await session.withTransaction(async () =>
          couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard),
        );
      } finally {
        await session.endSession();
      }
    };

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(1);
    const redemptions = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      customerId,
    });
    expect(redemptions).toBe(1);
  });

  // Final whole-branch review gap: `redeem` previously never checked
  // `coupon.isVipOnly` at all, so ANY customer could redeem a VIP-exclusive
  // coupon at actual checkout (a discount/revenue leak). `redeem` is the
  // authoritative gate — unlike `validateForPreview`'s pre-existing, separately
  // tracked bug that rejects VIP coupons for everyone including real VIPs,
  // `redeem` must get both directions right: block non-VIPs, allow real VIPs.
  it("rejects a non-VIP customer redeeming an isVipOnly coupon", async () => {
    const coupon = await makeCoupon({ isVipOnly: true });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () =>
        couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard),
      ),
    ).rejects.toThrow(/exclusivo para clientes VIP/);
    await session.endSession();

    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(0); // rolled back — never redeemed
  });

  it("allows a genuine VIP customer to redeem an isVipOnly coupon", async () => {
    const coupon = await makeCoupon({ isVipOnly: true });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    const result = await session.withTransaction(async () =>
      couponService.redeem(coupon.code, customerId, session, CustomerTier.Vip, 100000),
    );
    await session.endSession();

    expect(result!.discountCents).toBe(10000);
    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(1);
  });

  it("still allows a non-VIP customer to redeem a NON-VIP coupon (fix doesn't over-block)", async () => {
    const coupon = await makeCoupon({ isVipOnly: false });
    const customerId = new mongoose.Types.ObjectId().toString();

    const session = await mongoose.startSession();
    const result = await session.withTransaction(async () =>
      couponService.redeem(coupon.code, customerId, session, CustomerTier.Standard, 100000),
    );
    await session.endSession();

    expect(result!.discountCents).toBe(10000);
    const reloaded = await Coupon.findById(coupon.id);
    expect(reloaded!.usedCount).toBe(1);
  });
});
