import { Category } from "../models/Category.js";
import { nextSequence } from "../models/Counter.js";
import { AppError } from "./AppError.js";

/**
 * Generates the next variant SKU for a category: "<skuPrefix>-<4-digit seq>"
 * (e.g. "RING-0001"). The sequence comes from an atomic per-prefix counter, so
 * concurrent creations never collide.
 */

const generateVariantSku = async (categoryId: string): Promise<string> => {
  const category = await Category.findById(categoryId);
  if (!category) {
    throw new AppError("Categoría no válida", 400);
  }
  const seq = await nextSequence(`sku:${category.skuPrefix}`);
  return `${category.skuPrefix}-${String(seq).padStart(4, "0")}`;
};

export { generateVariantSku };
