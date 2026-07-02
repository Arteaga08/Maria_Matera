import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * A purchasable variant of a product (size/material combination) with its own
 * SKU and stock. Stock lives here (not on Product) so reservations can update a
 * single document atomically. `available = onHand − reserved`.
 */

interface ProductVariantDocument extends Document {
  productId: Types.ObjectId;
  sku: string;
  size?: string;
  material?: string;
  priceCentsOverride?: number;
  onHand: number;
  reserved: number;
  attributes?: Map<string, string>;
  isArchived: boolean;
  readonly available: number;
  createdAt: Date;
  updatedAt: Date;
}

const productVariantSchema = new Schema<ProductVariantDocument>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    sku: { type: String, required: true, unique: true, index: true },
    size: { type: String, trim: true, maxlength: 40 },
    material: { type: String, trim: true, maxlength: 80 },
    priceCentsOverride: { type: Number, min: 0 },
    onHand: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    attributes: { type: Map, of: String },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

productVariantSchema.virtual("available").get(function available(this: ProductVariantDocument) {
  return this.onHand - this.reserved;
});

const ProductVariant: Model<ProductVariantDocument> =
  (models.ProductVariant as Model<ProductVariantDocument>) ??
  model<ProductVariantDocument>("ProductVariant", productVariantSchema);

export type { ProductVariantDocument };
export { ProductVariant };
