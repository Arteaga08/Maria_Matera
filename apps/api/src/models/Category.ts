import { Schema, model, models, type Document, type Model } from "mongoose";

/**
 * Product category as a managed entity (CRUD): carries its own SKU prefix
 * (used to auto-generate variant SKUs like "RING-0001") and imagery for
 * navigation/landing pages.
 */

interface CategoryImages {
  thumbnail?: string;
  banner?: string;
}

interface CategoryDocument extends Document {
  name: string;
  slug: string;
  skuPrefix: string;
  description?: string;
  images: CategoryImages;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, index: true },
    skuPrefix: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 8 },
    description: { type: String, trim: true, maxlength: 500 },
    images: {
      thumbnail: { type: String },
      banner: { type: String },
    },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const Category: Model<CategoryDocument> =
  (models.Category as Model<CategoryDocument>) ??
  model<CategoryDocument>("Category", categorySchema);

export type { CategoryDocument, CategoryImages };
export { Category };
