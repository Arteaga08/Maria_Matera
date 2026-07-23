import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * Anonymous product-view event feeding the "desire analysis" dashboard page
 * (views vs wishlist vs purchases). Deliberately minimal: productId +
 * createdAt only — no personal data, no session/device identity; the analysis
 * is product-level.
 *
 * Retention is a fixed 90-day policy identical for every event, so the TTL
 * index lives on `createdAt` directly (no per-document `expiresAt` field like
 * Token/RefreshToken, where each document has its own lifetime).
 */

const VIEW_EVENT_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

interface ProductViewEventDocument extends Document {
  productId: Types.ObjectId;
  createdAt: Date;
}

const productViewEventSchema = new Schema<ProductViewEventDocument>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Range aggregation per product (admin analysis).
productViewEventSchema.index({ productId: 1, createdAt: 1 });
// Mongo's TTL monitor prunes events older than the retention window.
productViewEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: VIEW_EVENT_TTL_SECONDS });

const ProductViewEvent: Model<ProductViewEventDocument> =
  (models.ProductViewEvent as Model<ProductViewEventDocument>) ??
  model<ProductViewEventDocument>("ProductViewEvent", productViewEventSchema);

export type { ProductViewEventDocument };
export { ProductViewEvent, VIEW_EVENT_TTL_SECONDS };
