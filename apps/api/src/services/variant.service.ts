import { UserType } from "@maria-matera/shared";
import { Product } from "../models/Product.js";
import { ProductVariant, type ProductVariantDocument } from "../models/ProductVariant.js";
import { AppError } from "../utils/AppError.js";
import { generateVariantSku } from "../utils/sku.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";

/**
 * Product variant business logic. SKU is auto-generated from the product's
 * category prefix. Stock (onHand/reserved) is NOT managed here — see the
 * inventory service.
 */

const MODULE = "Variantes";

interface VariantInput {
  size?: string;
  material?: string;
  priceCentsOverride?: number;
  attributes?: Record<string, string>;
}

const getVariantDoc = async (variantId: string): Promise<ProductVariantDocument> => {
  const variant = await ProductVariant.findById(variantId);
  if (!variant) {
    throw new AppError("Variante no encontrada", 404);
  }
  return variant;
};

const addVariant = async (
  productId: string,
  input: VariantInput,
  actor: Actor,
): Promise<ProductVariantDocument> => {
  const product = await Product.findById(productId);
  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }
  const sku = await generateVariantSku(String(product.categoryId));
  const variant = await ProductVariant.create({ productId: product._id, sku, ...input });
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "CREATE",
    module: MODULE,
    targetId: variant.id as string,
    after: variant.toObject(),
    ip: actor.ip,
  });
  return variant;
};

const updateVariant = async (
  variantId: string,
  input: VariantInput,
  actor: Actor,
): Promise<ProductVariantDocument> => {
  const variant = await getVariantDoc(variantId);
  const before = variant.toObject();
  Object.assign(variant, input);
  await variant.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "UPDATE",
    module: MODULE,
    targetId: variant.id as string,
    before,
    after: variant.toObject(),
    ip: actor.ip,
  });
  return variant;
};

const archiveVariant = async (variantId: string, actor: Actor): Promise<void> => {
  const variant = await getVariantDoc(variantId);
  variant.isArchived = true;
  await variant.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ARCHIVE",
    module: MODULE,
    targetId: variant.id as string,
    ip: actor.ip,
  });
};

export type { VariantInput };
export { addVariant, updateVariant, archiveVariant };
