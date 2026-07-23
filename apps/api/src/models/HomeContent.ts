import { Schema, model, models, Types, type Document, type Model } from "mongoose";
import { AnnouncementType, HeroMediaType } from "@maria-matera/shared";

/**
 * Home content singleton (content editor). Exactly one document is ever
 * expected to exist, at the fixed `HOME_CONTENT_ID` below — read/upserted via
 * `content.service.ts`, same race-safe pattern as `Settings.ts` (the `_id`
 * unique index is the atomicity guard).
 *
 * Sections are typed on purpose (no generic page-builder): hero slides,
 * curated product selections (new arrivals / best sellers) and one
 * announcement (bar or popup). Visibility is a plain `isActive` flag per
 * piece — no campaign scheduling by design.
 */

const HOME_CONTENT_ID = new Types.ObjectId("000000000000000000000002"); // Settings uses ...0001

interface HeroSlide {
  mediaType: HeroMediaType;
  mediaUrl: string;
  title?: string;
  subtitle?: string;
  ctaLabel?: string;
  ctaHref?: string;
  isActive: boolean;
}

interface CuratedSection {
  productIds: Types.ObjectId[];
  isActive: boolean;
}

interface HomeAnnouncement {
  text: string;
  href?: string;
  type: AnnouncementType;
  isActive: boolean;
}

interface HomeContentDocument extends Document {
  hero: { slides: HeroSlide[] };
  newArrivals: CuratedSection;
  bestSellers: CuratedSection;
  announcement: HomeAnnouncement;
  createdAt: Date;
  updatedAt: Date;
}

const heroSlideSchema = new Schema<HeroSlide>(
  {
    mediaType: { type: String, enum: Object.values(HeroMediaType), required: true },
    mediaUrl: { type: String, required: true },
    title: { type: String, trim: true, maxlength: 160 },
    subtitle: { type: String, trim: true, maxlength: 160 },
    ctaLabel: { type: String, trim: true, maxlength: 60 },
    ctaHref: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const curatedSectionSchema = new Schema<CuratedSection>(
  {
    productIds: { type: [{ type: Schema.Types.ObjectId, ref: "Product" }], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const homeContentSchema = new Schema<HomeContentDocument>(
  {
    hero: {
      slides: { type: [heroSlideSchema], default: [] },
    },
    newArrivals: { type: curatedSectionSchema, default: () => ({}) },
    bestSellers: { type: curatedSectionSchema, default: () => ({}) },
    announcement: {
      text: { type: String, trim: true, maxlength: 200, default: "" },
      href: { type: String, trim: true },
      type: {
        type: String,
        enum: Object.values(AnnouncementType),
        default: AnnouncementType.Bar,
      },
      isActive: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

const HomeContent: Model<HomeContentDocument> =
  (models.HomeContent as Model<HomeContentDocument>) ??
  model<HomeContentDocument>("HomeContent", homeContentSchema);

export type { HomeContentDocument, HeroSlide, CuratedSection, HomeAnnouncement };
export { HomeContent, HOME_CONTENT_ID };
