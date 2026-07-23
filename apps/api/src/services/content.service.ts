import { Types } from "mongoose";
import { UserType, type Currency } from "@maria-matera/shared";
import {
  HomeContent,
  HOME_CONTENT_ID,
  type HomeContentDocument,
  type HeroSlide,
  type HomeAnnouncement,
} from "../models/HomeContent.js";
import { Product } from "../models/Product.js";
import { recordAudit } from "./audit.service.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";

/**
 * Home content singleton service (content editor subsystem).
 *
 * Writes are per-section `$set`s on the singleton document — two admins
 * editing different sections can never clobber each other, and every update
 * gets its own granular audit entry (module "content").
 *
 * Curated product ids are validated twice by design: on write (immediate
 * feedback in the dashboard when a product is missing/unpublished/archived)
 * and again on the public read (a product archived AFTER being curated is
 * silently dropped so the storefront home never breaks).
 */

interface HeroInput {
  slides: HeroSlide[];
}

interface CuratedSectionInput {
  productIds: string[];
  isActive: boolean;
}

type CuratedSectionName = "newArrivals" | "bestSellers";

interface PublicProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: Currency;
  image?: string;
}

interface PublicHomeContent {
  hero: { slides: Omit<HeroSlide, "isActive">[] };
  newArrivals: { products: PublicProduct[] };
  bestSellers: { products: PublicProduct[] };
  announcement: Omit<HomeAnnouncement, "isActive"> | null;
}

const AUDIT_MODULE = "content";

const SECTION_AUDIT_ACTIONS: Record<CuratedSectionName, string> = {
  newArrivals: "UPDATE_NEW_ARRIVALS",
  bestSellers: "UPDATE_BEST_SELLERS",
};

const PUBLIC_PRODUCT_FILTER = { isPublished: true, isArchived: false };

/** Race-safe singleton read/upsert — same pattern as `settings.service.get`. */
const getAdmin = async (): Promise<HomeContentDocument> => {
  const doc = await HomeContent.findByIdAndUpdate(
    HOME_CONTENT_ID,
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!doc) {
    // Unreachable in practice (upsert + new always returns the document);
    // guarded only to avoid a non-null assertion.
    throw new AppError("No se pudo cargar el contenido del home.", 500);
  }
  return doc;
};

/** Rejects curated ids that don't exist or aren't publicly sellable. */
const assertProductsCurated = async (productIds: string[]): Promise<void> => {
  if (productIds.length === 0) return;
  const found = await Product.find({ _id: { $in: productIds }, ...PUBLIC_PRODUCT_FILTER })
    .select("_id")
    .lean();
  if (found.length !== productIds.length) {
    throw new AppError(
      "Uno o más productos seleccionados no existen, no están publicados o están archivados.",
      400,
    );
  }
};

const setSection = async (
  section: "hero" | CuratedSectionName | "announcement",
  value: unknown,
  action: string,
  actor: Actor,
): Promise<HomeContentDocument> => {
  const previous = await getAdmin();
  const before = previous.toObject()[section] as unknown;
  const updated = await HomeContent.findByIdAndUpdate(
    HOME_CONTENT_ID,
    { $set: { [section]: value } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
  if (!updated) {
    throw new AppError("No se pudo actualizar el contenido del home.", 500);
  }
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action,
    module: AUDIT_MODULE,
    targetId: HOME_CONTENT_ID.toHexString(),
    before,
    after: updated.toObject()[section] as unknown,
    ip: actor.ip,
  });
  return updated;
};

const updateHero = (input: HeroInput, actor: Actor): Promise<HomeContentDocument> =>
  setSection("hero", { slides: input.slides }, "UPDATE_HERO", actor);

const updateCuratedSection = async (
  section: CuratedSectionName,
  input: CuratedSectionInput,
  actor: Actor,
): Promise<HomeContentDocument> => {
  await assertProductsCurated(input.productIds);
  const value = {
    productIds: input.productIds.map((id) => new Types.ObjectId(id)),
    isActive: input.isActive,
  };
  return setSection(section, value, SECTION_AUDIT_ACTIONS[section], actor);
};

const updateAnnouncement = (
  input: HomeAnnouncement,
  actor: Actor,
): Promise<HomeContentDocument> => setSection("announcement", input, "UPDATE_ANNOUNCEMENT", actor);

/** Fetches curated products keeping the curated order (`$in` ignores order). */
const fetchCuratedProducts = async (ids: Types.ObjectId[]): Promise<PublicProduct[]> => {
  if (ids.length === 0) return [];
  const products = await Product.find({ _id: { $in: ids }, ...PUBLIC_PRODUCT_FILTER })
    .select("name slug priceCents currency images.cardPrimary")
    .lean();
  const byId = new Map<string, PublicProduct>(
    products.map((p) => [
      String(p._id),
      {
        id: String(p._id),
        name: p.name,
        slug: p.slug,
        priceCents: p.priceCents,
        currency: p.currency,
        ...(p.images?.cardPrimary ? { image: p.images.cardPrimary } : {}),
      },
    ]),
  );
  return ids.map((id) => byId.get(String(id))).filter((p): p is PublicProduct => p !== undefined);
};

/** Public storefront read: only active pieces, stable four-key shape. */
const getPublic = async (): Promise<PublicHomeContent> => {
  const doc = await HomeContent.findById(HOME_CONTENT_ID).lean();
  if (!doc) {
    return {
      hero: { slides: [] },
      newArrivals: { products: [] },
      bestSellers: { products: [] },
      announcement: null,
    };
  }

  const slides = doc.hero.slides
    .filter((slide) => slide.isActive)
    .map(({ isActive: _isActive, ...rest }) => rest);

  const [newArrivals, bestSellers] = await Promise.all([
    doc.newArrivals.isActive ? fetchCuratedProducts(doc.newArrivals.productIds) : [],
    doc.bestSellers.isActive ? fetchCuratedProducts(doc.bestSellers.productIds) : [],
  ]);

  const announcement =
    doc.announcement.isActive && doc.announcement.text
      ? {
          text: doc.announcement.text,
          ...(doc.announcement.href ? { href: doc.announcement.href } : {}),
          type: doc.announcement.type,
        }
      : null;

  return {
    hero: { slides },
    newArrivals: { products: newArrivals },
    bestSellers: { products: bestSellers },
    announcement,
  };
};

export type {
  HeroInput,
  CuratedSectionInput,
  CuratedSectionName,
  PublicProduct,
  PublicHomeContent,
};
export { getAdmin, getPublic, updateHero, updateCuratedSection, updateAnnouncement };
