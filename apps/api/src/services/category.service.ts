import { UserType } from "@maria-matera/shared";
import { Category, type CategoryDocument } from "../models/Category.js";
import { AppError } from "../utils/AppError.js";
import { uniqueSlug } from "../utils/slug.js";
import { recordAudit } from "./audit.service.js";

/**
 * Category business logic. Admin mutations are audited. Categories use a soft
 * `isActive` flag instead of hard deletes to preserve product references.
 */

const MODULE = "Categorías";

interface Actor {
  id: string;
  ip?: string;
}

interface CreateCategoryInput {
  name: string;
  skuPrefix: string;
  description?: string;
  images?: { thumbnail?: string; banner?: string };
  isActive?: boolean;
  sortOrder?: number;
}

type UpdateCategoryInput = Partial<CreateCategoryInput>;

const listPublic = (): Promise<CategoryDocument[]> =>
  Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).exec();

const adminList = (): Promise<CategoryDocument[]> =>
  Category.find().sort({ sortOrder: 1, name: 1 }).exec();

const getBySlug = async (slug: string): Promise<CategoryDocument> => {
  const category = await Category.findOne({ slug, isActive: true });
  if (!category) {
    throw new AppError("Categoría no encontrada", 404);
  }
  return category;
};

const adminGet = async (id: string): Promise<CategoryDocument> => {
  const category = await Category.findById(id);
  if (!category) {
    throw new AppError("Categoría no encontrada", 404);
  }
  return category;
};

const create = async (input: CreateCategoryInput, actor: Actor): Promise<CategoryDocument> => {
  const slug = await uniqueSlug(Category, input.name);
  const category = await Category.create({ ...input, slug });
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "CREATE",
    module: MODULE,
    targetId: category.id as string,
    after: category.toObject(),
    ip: actor.ip,
  });
  return category;
};

const update = async (
  id: string,
  input: UpdateCategoryInput,
  actor: Actor,
): Promise<CategoryDocument> => {
  const category = await adminGet(id);
  const before = category.toObject();
  Object.assign(category, input);
  await category.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "UPDATE",
    module: MODULE,
    targetId: category.id as string,
    before,
    after: category.toObject(),
    ip: actor.ip,
  });
  return category;
};

const remove = async (id: string, actor: Actor): Promise<void> => {
  const category = await adminGet(id);
  category.isActive = false;
  await category.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ARCHIVE",
    module: MODULE,
    targetId: category.id as string,
    ip: actor.ip,
  });
};

export type { CreateCategoryInput, UpdateCategoryInput, Actor };
export { listPublic, adminList, getBySlug, adminGet, create, update, remove };
