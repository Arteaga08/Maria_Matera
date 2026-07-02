import { CouponType, UserType } from "@maria-matera/shared";
import { Coupon, type CouponDocument } from "../models/Coupon.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";

/**
 * Coupon business logic. Admin CRUD (audited) + a public preview/validation that
 * checks activeness, validity window, redemption cap and minimum purchase, and
 * computes the discount. Atomic redemption happens at checkout (Paso 3).
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

export type { CreateCouponInput, UpdateCouponInput, CouponPreview };
export { adminList, adminGet, create, update, remove, validateForPreview, computeDiscount };
