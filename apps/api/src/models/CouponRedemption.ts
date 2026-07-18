import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * One document per successful coupon redemption by a customer. A dedicated
 * append-style collection (rather than an embedded array on `Coupon`) mirrors
 * `StockReservation`'s pattern: a popular coupon can be redeemed by thousands
 * of customers, and an embedded array on the `Coupon` document would grow
 * unbounded and bloat it. `perUserLimit` is enforced by counting the
 * customer's redemptions for a given coupon rather than a hard unique index,
 * since the limit can be greater than 1.
 */

interface CouponRedemptionDocument extends Document {
  couponId: Types.ObjectId;
  customerId: Types.ObjectId;
  createdAt: Date;
}

const couponRedemptionSchema = new Schema<CouponRedemptionDocument>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Backs the per-user-limit lookup (`countDocuments({ couponId, customerId })`).
couponRedemptionSchema.index({ couponId: 1, customerId: 1 });

const CouponRedemption: Model<CouponRedemptionDocument> =
  (models.CouponRedemption as Model<CouponRedemptionDocument>) ??
  model<CouponRedemptionDocument>("CouponRedemption", couponRedemptionSchema);

export type { CouponRedemptionDocument };
export { CouponRedemption };
