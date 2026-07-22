import { Schema, model, models, type Document, type Model } from "mongoose";
import { CouponType } from "@maria-matera/shared";

/**
 * Discount coupon. `value` meaning depends on `type`: percent (1–100), fixed
 * (amount in cents), or free_shipping (value ignored). Atomic redemption
 * (usedCount / per-user limits) happens at checkout — this model just holds the
 * definition and current usage.
 */

interface CouponDocument extends Document {
  code: string;
  type: CouponType;
  value: number;
  description?: string;
  minPurchaseCents?: number;
  maxRedemptions?: number;
  perUserLimit?: number;
  usedCount: number;
  validFrom: Date;
  validTo: Date;
  isVipOnly: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<CouponDocument>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    type: { type: String, enum: Object.values(CouponType), required: true },
    value: { type: Number, required: true, min: 0 },
    description: { type: String, trim: true, maxlength: 280 },
    minPurchaseCents: { type: Number, min: 0 },
    maxRedemptions: { type: Number, min: 1 },
    perUserLimit: { type: Number, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    isVipOnly: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

const Coupon: Model<CouponDocument> =
  (models.Coupon as Model<CouponDocument>) ?? model<CouponDocument>("Coupon", couponSchema);

export type { CouponDocument };
export { Coupon };
