import { Category } from "../models/Category.js";
import { slugify } from "../utils/slug.js";

/**
 * Seeds the base jewelry categories (idempotent — upsert by slug). Each carries
 * the SKU prefix used to generate variant SKUs.
 */

const BASE_CATEGORIES: { name: string; skuPrefix: string; sortOrder: number }[] = [
  { name: "Brazaletes", skuPrefix: "BRAC", sortOrder: 1 },
  { name: "Anillos", skuPrefix: "RING", sortOrder: 2 },
  { name: "Collares", skuPrefix: "NECK", sortOrder: 3 },
  { name: "Aretes", skuPrefix: "EAR", sortOrder: 4 },
  { name: "Baby Gold", skuPrefix: "BABY", sortOrder: 5 },
];

const seedCategories = async (): Promise<number> => {
  for (const category of BASE_CATEGORIES) {
    await Category.updateOne(
      { slug: slugify(category.name) },
      { $setOnInsert: { ...category, slug: slugify(category.name) } },
      { upsert: true },
    );
  }
  return BASE_CATEGORIES.length;
};

export { seedCategories, BASE_CATEGORIES };
