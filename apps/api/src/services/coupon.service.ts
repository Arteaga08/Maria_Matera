import type { ClientSession } from "mongoose";
import { CouponType, CustomerTier, UserType } from "@maria-matera/shared";
import { Coupon, type CouponDocument } from "../models/Coupon.js";
import { CouponRedemption } from "../models/CouponRedemption.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";

/**
 * Coupon business logic. Admin CRUD (audited) + a public preview/validation that
 * checks activeness, validity window, redemption cap and minimum purchase, and
 * computes the discount. Atomic redemption (`redeem`) happens at checkout
 * (Task 3): it is meant to run INSIDE a caller-managed transaction (the future
 * Order-creation transaction), so it never starts/commits its own session —
 * every read/write it performs uses the `session` passed in.
 */

const MODULE = "Cupones";

interface CreateCouponInput {
  code: string;
  type: CouponType;
  value: number;
  minPurchaseCents?: number;
  maxRedemptions?: number;
  perUserLimit?: number;
  validFrom: Date;
  validTo: Date;
  isVipOnly?: boolean;
  isActive?: boolean;
}

type UpdateCouponInput = Partial<Omit<CreateCouponInput, "code" | "type" | "value">>;

interface CouponPreview {
  code: string;
  type: CouponType;
  value: number;
  isVipOnly: boolean;
  discountCents?: number;
}

const computeDiscount = (coupon: CouponDocument, subtotalCents: number): number => {
  if (coupon.type === CouponType.Percent) {
    return Math.round((subtotalCents * coupon.value) / 100);
  }
  if (coupon.type === CouponType.Fixed) {
    return Math.min(coupon.value, subtotalCents);
  }
  return 0; // free_shipping: applied against shipping cost at checkout
};

const adminList = (): Promise<CouponDocument[]> =>
  Coupon.find().sort({ createdAt: -1 }).exec();

const adminGet = async (id: string): Promise<CouponDocument> => {
  const coupon = await Coupon.findById(id);
  if (!coupon) {
    throw new AppError("Cupón no encontrado", 404);
  }
  return coupon;
};

const create = async (input: CreateCouponInput, actor: Actor): Promise<CouponDocument> => {
  const coupon = await Coupon.create(input);
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "CREATE",
    module: MODULE,
    targetId: coupon.id as string,
    after: coupon.toObject(),
    ip: actor.ip,
  });
  return coupon;
};

const update = async (
  id: string,
  input: UpdateCouponInput,
  actor: Actor,
): Promise<CouponDocument> => {
  const coupon = await adminGet(id);
  const before = coupon.toObject();
  Object.assign(coupon, input);
  await coupon.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "UPDATE",
    module: MODULE,
    targetId: coupon.id as string,
    before,
    after: coupon.toObject(),
    ip: actor.ip,
  });
  return coupon;
};

const remove = async (id: string, actor: Actor): Promise<void> => {
  const coupon = await adminGet(id);
  coupon.isActive = false;
  await coupon.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ARCHIVE",
    module: MODULE,
    targetId: coupon.id as string,
    ip: actor.ip,
  });
};

const validateForPreview = async (
  code: string,
  subtotalCents?: number,
): Promise<CouponPreview> => {
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
  if (!coupon) {
    throw new AppError("Cupón no válido.", 404);
  }

  const now = Date.now();
  if (now < coupon.validFrom.getTime() || now > coupon.validTo.getTime()) {
    throw new AppError("El cupón no está vigente.", 400);
  }
  if (coupon.maxRedemptions !== undefined && coupon.usedCount >= coupon.maxRedemptions) {
    throw new AppError("El cupón ya no está disponible.", 400);
  }
  if (coupon.isVipOnly) {
    throw new AppError("Este cupón es exclusivo para clientes VIP.", 403);
  }
  if (
    coupon.minPurchaseCents !== undefined &&
    subtotalCents !== undefined &&
    subtotalCents < coupon.minPurchaseCents
  ) {
    const min = (coupon.minPurchaseCents / 100).toFixed(2);
    throw new AppError(`El cupón requiere una compra mínima de $${min}.`, 400);
  }

  return {
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    isVipOnly: coupon.isVipOnly,
    discountCents: subtotalCents !== undefined ? computeDiscount(coupon, subtotalCents) : undefined,
  };
};

interface RedeemResult {
  coupon: CouponDocument;
  discountCents?: number;
}

/**
 * Atomically redeems a coupon for a customer: bumps `usedCount` only if the
 * coupon is currently active, within its validity window, and under
 * `maxRedemptions` — all in the same `findOneAndUpdate` condition-and-increment
 * command (mirrors `inventoryService.reserveStock`'s pattern), so there is no
 * read-then-write window for a concurrent redemption to sneak through.
 *
 * `maxRedemptions` is optional on the schema (absent means "unlimited"). A raw
 * `$expr: { $lt: ["$usedCount", "$maxRedemptions"] } ` would NOT treat a
 * missing `maxRedemptions` as "no limit" — verified empirically against a real
 * Mongo instance, a document with the field entirely absent matches *zero*
 * `$lt` comparisons against it, so every redemption would be wrongly rejected.
 * `$ifNull` supplies a very large fallback so an unset `maxRedemptions` is
 * never blocked by this check.
 *
 * The per-user limit (`perUserLimit`) is enforced via a dedicated
 * `CouponRedemption` collection (one doc per redemption event) rather than an
 * embedded array on `Coupon` — same reasoning as `StockReservation` living
 * next to `ProductVariant`: a popular coupon redeemed by thousands of
 * customers would otherwise bloat the `Coupon` document unboundedly. Counting
 * (rather than a hard unique index) is used because `perUserLimit` can be
 * greater than 1.
 *
 * Atomicity of "check the customer's redemption count, then record a new one"
 * relies on both operations running in the SAME session/transaction as the
 * `usedCount` increment above. Because that increment always targets the same
 * `Coupon` document, two concurrent redemption attempts for the SAME coupon
 * necessarily conflict on that document at the storage engine level — one
 * transaction is forced to abort/retry (surfaced by the driver's
 * `session.withTransaction` retry loop) and only proceeds with its per-user
 * check once the other has already committed (or rolled back). This closes
 * the TOCTOU window a customer double-submitting the same coupon could
 * otherwise exploit against a `perUserLimit: 1` coupon.
 *
 * That whole argument only holds if the caller actually opened a real
 * multi-document transaction on `session` — a plain session with no
 * transaction in progress would auto-commit the increment, the count read,
 * and the insert independently, silently reintroducing the race. `redeem`
 * therefore refuses to run outside an active transaction rather than fail
 * quietly.
 *
 * `customerTier` gates `isVipOnly` coupons: unlike `validateForPreview` (which
 * looks the coupon up standalone with no notion of who's asking), `redeem` is
 * the actual authoritative checkout gate, so it must know the redeeming
 * customer's real tier. It takes it as an explicit parameter rather than
 * re-fetching the `Customer` document itself — the caller (`createOrder`)
 * already loaded it earlier in its flow (for address snapshotting), so
 * re-querying here would be redundant and would blur `redeem`'s job, which is
 * about the coupon, not customer lookup.
 */
const redeem = async (
  code: string,
  customerId: string,
  session: ClientSession,
  customerTier: CustomerTier,
  subtotalCents?: number,
): Promise<RedeemResult> => {
  if (!session.inTransaction()) {
    throw new AppError("redeem debe ejecutarse dentro de una transacción.", 500);
  }

  const now = new Date();
  const coupon = await Coupon.findOneAndUpdate(
    {
      code: code.toUpperCase(),
      isActive: true,
      validFrom: { $lte: now },
      validTo: { $gte: now },
      $expr: {
        $lt: ["$usedCount", { $ifNull: ["$maxRedemptions", Number.MAX_SAFE_INTEGER] }],
      },
    },
    { $inc: { usedCount: 1 } },
    { session, new: true },
  );
  if (!coupon) {
    throw new AppError("El cupón no está disponible.", 409);
  }

  if (coupon.isVipOnly && customerTier !== CustomerTier.Vip) {
    throw new AppError("Este cupón es exclusivo para clientes VIP.", 403);
  }

  if (
    coupon.minPurchaseCents !== undefined &&
    subtotalCents !== undefined &&
    subtotalCents < coupon.minPurchaseCents
  ) {
    const min = (coupon.minPurchaseCents / 100).toFixed(2);
    throw new AppError(`El cupón requiere una compra mínima de $${min}.`, 400);
  }

  if (coupon.perUserLimit !== undefined) {
    const redemptionCount = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      customerId,
    }).session(session);
    if (redemptionCount >= coupon.perUserLimit) {
      throw new AppError("Ya utilizaste este cupón el máximo de veces permitido.", 409);
    }
  }

  await CouponRedemption.create([{ couponId: coupon._id, customerId }], { session });

  return {
    coupon,
    discountCents:
      subtotalCents !== undefined ? computeDiscount(coupon, subtotalCents) : undefined,
  };
};

export type { CreateCouponInput, UpdateCouponInput, CouponPreview, RedeemResult };
export {
  adminList,
  adminGet,
  create,
  update,
  remove,
  validateForPreview,
  computeDiscount,
  redeem,
};
