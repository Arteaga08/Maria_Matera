import { Schema, model, models, type Document, type Model } from "mongoose";

/**
 * Collection ("Mood"/season): a curated grouping of products with hero media for
 * editorial landing pages.
 */

interface CollectionHeroMedia {
  image?: string;
  video?: string;
}

interface CollectionDocument extends Document {
  name: string;
  slug: string;
  description?: string;
  heroMedia: CollectionHeroMedia;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const collectionSchema = new Schema<CollectionDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true, maxlength: 1000 },
    heroMedia: {
      image: { type: String },
      video: { type: String },
    },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const Collection: Model<CollectionDocument> =
  (models.Collection as Model<CollectionDocument>) ??
  model<CollectionDocument>("Collection", collectionSchema);

export type { CollectionDocument, CollectionHeroMedia };
export { Collection };
