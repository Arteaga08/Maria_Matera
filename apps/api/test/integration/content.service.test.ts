import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { AnnouncementType, HeroMediaType } from "@maria-matera/shared";
import { HomeContent, HOME_CONTENT_ID } from "../../src/models/HomeContent.js";
import { Product } from "../../src/models/Product.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import * as contentService from "../../src/services/content.service.js";
import { AppError } from "../../src/utils/AppError.js";

/**
 * Home content singleton service (content editor subsystem). Covers the
 * race-safe upsert, curated-product validation on write, and the public read
 * that filters inactive/unpublished pieces while preserving curated order.
 */

const ACTOR = { id: new mongoose.Types.ObjectId().toHexString(), ip: "127.0.0.1" };

let productCounter = 0;
const makeProduct = async (
  overrides: Partial<{ isPublished: boolean; isArchived: boolean }> = {},
) => {
  productCounter += 1;
  return Product.create({
    name: `Pieza ${productCounter}`,
    slug: `pieza-${productCounter}`,
    description: "Joya de prueba",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 100000,
    images: { cardPrimary: `https://res.cloudinary.com/demo/p${productCounter}.jpg` },
    isPublished: overrides.isPublished ?? true,
    isArchived: overrides.isArchived ?? false,
  });
};

const activeSlide = (overrides: Partial<Record<string, unknown>> = {}) => ({
  mediaType: HeroMediaType.Image,
  mediaUrl: "https://res.cloudinary.com/demo/hero.jpg",
  title: "Nueva colección",
  isActive: true,
  ...overrides,
});

describe("content.service singleton", () => {
  it("getAdmin upserts the singleton idempotently with defaults", async () => {
    const first = await contentService.getAdmin();
    const second = await contentService.getAdmin();

    expect(String(first._id)).toBe(HOME_CONTENT_ID.toHexString());
    expect(String(second._id)).toBe(HOME_CONTENT_ID.toHexString());
    expect(await HomeContent.countDocuments()).toBe(1);
    expect(first.hero.slides).toEqual([]);
    expect(first.newArrivals.productIds).toEqual([]);
    expect(first.bestSellers.productIds).toEqual([]);
    expect(first.announcement.isActive).toBe(false);
  });
});

describe("content.service updateCuratedSection", () => {
  it("rejects ids that do not exist", async () => {
    const missing = new mongoose.Types.ObjectId().toHexString();

    await expect(
      contentService.updateCuratedSection(
        "newArrivals",
        { productIds: [missing], isActive: true },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects unpublished and archived products", async () => {
    const unpublished = await makeProduct({ isPublished: false });
    const archived = await makeProduct({ isArchived: true });

    for (const bad of [unpublished, archived]) {
      await expect(
        contentService.updateCuratedSection(
          "bestSellers",
          { productIds: [String(bad._id)], isActive: true },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(AppError);
    }
  });

  it("persists the curated selection and writes an audit entry", async () => {
    const a = await makeProduct();
    const b = await makeProduct();

    await contentService.updateCuratedSection(
      "newArrivals",
      { productIds: [String(b._id), String(a._id)], isActive: true },
      ACTOR,
    );

    const doc = await HomeContent.findById(HOME_CONTENT_ID);
    expect(doc!.newArrivals.productIds.map(String)).toEqual([String(b._id), String(a._id)]);

    const audit = await AuditLog.findOne({ module: "content", action: "UPDATE_NEW_ARRIVALS" });
    expect(audit).not.toBeNull();
    expect(String(audit!.actorId)).toBe(ACTOR.id);
    expect(audit!.targetId).toBe(HOME_CONTENT_ID.toHexString());
  });
});

describe("content.service updateHero / updateAnnouncement", () => {
  it("replaces hero slides and audits with before/after", async () => {
    await contentService.updateHero({ slides: [activeSlide()] }, ACTOR);
    await contentService.updateHero(
      { slides: [activeSlide({ title: "Segunda versión" })] },
      ACTOR,
    );

    const doc = await HomeContent.findById(HOME_CONTENT_ID);
    expect(doc!.hero.slides).toHaveLength(1);
    expect(doc!.hero.slides[0]!.title).toBe("Segunda versión");

    const audits = await AuditLog.find({ module: "content", action: "UPDATE_HERO" }).sort({
      createdAt: 1,
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.at(-1)!.before).toBeDefined();
    expect(audits.at(-1)!.after).toBeDefined();
  });

  it("updates the announcement", async () => {
    await contentService.updateAnnouncement(
      { text: "Envío gratis todo julio", type: AnnouncementType.Bar, isActive: true },
      ACTOR,
    );

    const doc = await HomeContent.findById(HOME_CONTENT_ID);
    expect(doc!.announcement.text).toBe("Envío gratis todo julio");
    expect(doc!.announcement.isActive).toBe(true);

    const audit = await AuditLog.findOne({ module: "content", action: "UPDATE_ANNOUNCEMENT" });
    expect(audit).not.toBeNull();
  });
});

describe("content.service getPublic", () => {
  it("returns a stable empty shape when nothing has been configured", async () => {
    await HomeContent.deleteMany({});

    const result = await contentService.getPublic();

    expect(result).toEqual({
      hero: { slides: [] },
      newArrivals: { products: [] },
      bestSellers: { products: [] },
      announcement: null,
    });
  });

  it("filters inactive slides and inactive announcement", async () => {
    await HomeContent.deleteMany({});
    await contentService.updateHero(
      { slides: [activeSlide(), activeSlide({ title: "Oculto", isActive: false })] },
      ACTOR,
    );
    await contentService.updateAnnouncement(
      { text: "Oculto", type: AnnouncementType.Popup, isActive: false },
      ACTOR,
    );

    const result = await contentService.getPublic();

    expect(result.hero.slides).toHaveLength(1);
    expect(result.hero.slides[0]).toMatchObject({ title: "Nueva colección" });
    expect(result.announcement).toBeNull();
  });

  it("preserves curated order and drops products unpublished/archived after curation", async () => {
    await HomeContent.deleteMany({});
    const a = await makeProduct();
    const b = await makeProduct();
    const c = await makeProduct();

    await contentService.updateCuratedSection(
      "bestSellers",
      { productIds: [String(c._id), String(a._id), String(b._id)], isActive: true },
      ACTOR,
    );
    // Archived AFTER curation — the public read must drop it without breaking.
    await Product.updateOne({ _id: b._id }, { $set: { isArchived: true } });

    const result = await contentService.getPublic();

    expect(result.bestSellers.products.map((p) => p.slug)).toEqual([c.slug, a.slug]);
    expect(result.bestSellers.products[0]).toEqual({
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      priceCents: 100000,
      currency: "MXN",
      image: c.images.cardPrimary,
    });
  });

  it("returns empty products for a section that is switched off", async () => {
    await HomeContent.deleteMany({});
    const a = await makeProduct();

    await contentService.updateCuratedSection(
      "newArrivals",
      { productIds: [String(a._id)], isActive: false },
      ACTOR,
    );

    const result = await contentService.getPublic();

    expect(result.newArrivals.products).toEqual([]);
  });
});
