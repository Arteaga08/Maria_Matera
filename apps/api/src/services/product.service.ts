import type { FilterQuery } from "mongoose";
import { UserType } from "@maria-matera/shared";
import type { PaginationMeta } from "@maria-matera/shared";
import { Product, type ProductDocument } from "../models/Product.js";
import { ProductVariant, type ProductVariantDocument } from "../models/ProductVariant.js";
import { Category } from "../models/Category.js";
import { Collection } from "../models/Collection.js";
import { AppError } from "../utils/AppError.js";
import { uniqueSlug } from "../utils/slug.js";
import { generateVariantSku } from "../utils/sku.js";
import { parseListQuery, buildMeta } from "../utils/listQuery.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";

/**
 * Product catalog business logic. Public listing supports filtering, search and
 * pagination; admin CRUD is audited. On creation a default variant is generated
 * (every product has ≥1 variant). Stock is never set here.
 */

const MODULE = "Productos";
const ALLOWED_SORT = ["priceCents", "createdAt", "name"];

interface CreateProductInput {
  name: string;
  description: string;
  categoryId: string;
  collectionId?: string;
  priceCents: number;
  currency?: string;
  material?: string;
  stone?: { type?: string; carat?: number };
  images?: { cardPrimary?: string; cardHover?: string; gallery?: string[] };
  isVipExclusive?: boolean;
  releaseAt?: Date;
}

type UpdateProductInput = Partial<CreateProductInput>;

interface ProductWithVariants {
  product: ProductDocument;
  variants: ProductVariantDocument[];
}

const toCents = (value: unknown): number | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  const pesos = Number(value);
  return Number.isFinite(pesos) && pesos >= 0 ? Math.round(pesos * 100) : undefined;
};

const normalizeSort = (query: Record<string, unknown>): Record<string, unknown> => {
  const raw = typeof query.sort === "string" ? query.sort : "";
  const mapped = raw === "price" ? "priceCents" : raw === "-price" ? "-priceCents" : raw;
  return { ...query, sort: mapped };
};

const listPublic = async (
  query: Record<string, unknown>,
): Promise<{ items: ProductDocument[]; meta: PaginationMeta }> => {
  const { page, pageSize, skip, sort } = parseListQuery(normalizeSort(query), {
    allowedSort: ALLOWED_SORT,
    defaultSort: "-createdAt",
  });

  const filter: FilterQuery<ProductDocument> = { isPublished: true, isArchived: false };

  if (typeof query.category === "string") {
    const category = await Category.findOne({ slug: query.category });
    filter.categoryId = category?._id ?? null;
  }
  if (typeof query.collection === "string") {
    const collection = await Collection.findOne({ slug: query.collection });
    filter.collectionId = collection?._id ?? null;
  }
  if (typeof query.material === "string") {
    filter.material = query.material;
  }
  if (typeof query.stone === "string") {
    filter["stone.type"] = query.stone;
  }
  const priceMin = toCents(query.priceMin);
  const priceMax = toCents(query.priceMax);
  if (priceMin !== undefined || priceMax !== undefined) {
    filter.priceCents = {
      ...(priceMin !== undefined ? { $gte: priceMin } : {}),
      ...(priceMax !== undefined ? { $lte: priceMax } : {}),
    };
  }
  if (typeof query.search === "string" && query.search.trim()) {
    filter.$text = { $search: query.search.trim() };
  }

  const [items, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(pageSize).exec(),
    Product.countDocuments(filter),
  ]);
  return { items, meta: buildMeta(page, pageSize, total) };
};

const getBySlugPublic = async (slug: string): Promise<ProductWithVariants> => {
  const product = await Product.findOne({ slug, isPublished: true, isArchived: false });
  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }
  const variants = await ProductVariant.find({ productId: product._id, isArchived: false });
  return { product, variants };
};

const adminList = async (
  query: Record<string, unknown>,
): Promise<{ items: ProductDocument[]; meta: PaginationMeta }> => {
  const { page, pageSize, skip, sort } = parseListQuery(normalizeSort(query), {
    allowedSort: ALLOWED_SORT,
    defaultSort: "-createdAt",
  });
  const [items, total] = await Promise.all([
    Product.find().sort(sort).skip(skip).limit(pageSize).exec(),
    Product.countDocuments(),
  ]);
  return { items, meta: buildMeta(page, pageSize, total) };
};

const getProductDoc = async (id: string): Promise<ProductDocument> => {
  const product = await Product.findById(id);
  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }
  return product;
};

const adminGet = async (id: string): Promise<ProductWithVariants> => {
  const product = await getProductDoc(id);
  const variants = await ProductVariant.find({ productId: product._id });
  return { product, variants };
};

const assertReferences = async (categoryId?: string, collectionId?: string): Promise<void> => {
  if (categoryId && !(await Category.exists({ _id: categoryId }))) {
    throw new AppError("Categoría no válida", 400);
  }
  if (collectionId && !(await Collection.exists({ _id: collectionId }))) {
    throw new AppError("Colección no válida", 400);
  }
};

const create = async (input: CreateProductInput, actor: Actor): Promise<ProductWithVariants> => {
  await assertReferences(input.categoryId, input.collectionId);
  const slug = await uniqueSlug(Product, input.name);
  const product = await Product.create({ ...input, slug });

  // Every product ships with at least one (default) variant.
  const sku = await generateVariantSku(String(product.categoryId));
  const variant = await ProductVariant.create({ productId: product._id, sku });

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "CREATE",
    module: MODULE,
    targetId: product.id as string,
    after: product.toObject(),
    ip: actor.ip,
  });
  return { product, variants: [variant] };
};

const update = async (
  id: string,
  input: UpdateProductInput,
  actor: Actor,
): Promise<ProductDocument> => {
  await assertReferences(input.categoryId, input.collectionId);
  const product = await getProductDoc(id);
  const before = product.toObject();
  Object.assign(product, input);
  await product.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "UPDATE",
    module: MODULE,
    targetId: product.id as string,
    before,
    after: product.toObject(),
    ip: actor.ip,
  });
  return product;
};

const setPublished = async (
  id: string,
  isPublished: boolean,
  actor: Actor,
): Promise<ProductDocument> => {
  const product = await getProductDoc(id);
  product.isPublished = isPublished;
  await product.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: isPublished ? "PUBLISH" : "UNPUBLISH",
    module: MODULE,
    targetId: product.id as string,
    ip: actor.ip,
  });
  return product;
};

const archive = async (id: string, actor: Actor): Promise<void> => {
  const product = await getProductDoc(id);
  product.isArchived = true;
  product.isPublished = false;
  await product.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ARCHIVE",
    module: MODULE,
    targetId: product.id as string,
    ip: actor.ip,
  });
};

export type { CreateProductInput, UpdateProductInput, ProductWithVariants };
export { listPublic, getBySlugPublic, adminList, adminGet, create, update, setPublished, archive };
