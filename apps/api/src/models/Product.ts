import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { Currency } from "@maria-matera/shared";

/**
 * Catalog product. Price is stored in integer minor units (`priceCents`) to
 * avoid floating-point money bugs. Category is a reference to the Category
 * entity. Variants (stock/SKU) live in a separate collection.
 */

interface ProductImages {
  cardPrimary?: string;
  cardHover?: string;
  gallery: string[];
}

interface ProductStone {
  type?: string;
  carat?: number;
}

interface ProductDocument extends Document {
  name: string;
  slug: string;
  description: string;
  categoryId: Types.ObjectId;
  collectionId?: Types.ObjectId;
  priceCents: number;
  currency: Currency;
  material?: string;
  stone?: ProductStone;
  images: ProductImages;
  isPublished: boolean;
  isVipExclusive: boolean;
  releaseAt?: Date;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<ProductDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    collectionId: { type: Schema.Types.ObjectId, ref: "Collection", index: true },
    priceCents: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: Object.values(Currency), default: Currency.Mxn },
    material: { type: String, trim: true, maxlength: 80 },
    stone: {
      type: { type: String, trim: true, maxlength: 80 },
      carat: { type: Number, min: 0 },
    },
    images: {
      cardPrimary: { type: String },
      cardHover: { type: String },
      gallery: { type: [String], default: [] },
    },
    isPublished: { type: Boolean, default: false, index: true },
    isVipExclusive: { type: Boolean, default: false },
    releaseAt: { type: Date },
    isArchived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

// Full-text search over name + description for the public catalog.
productSchema.index({ name: "text", description: "text" });

const Product: Model<ProductDocument> =
  (models.Product as Model<ProductDocument>) ??
  model<ProductDocument>("Product", productSchema);

export type { ProductDocument, ProductImages, ProductStone };
export { Product };
