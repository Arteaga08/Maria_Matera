import { UserType } from "@maria-matera/shared";
import { Collection, type CollectionDocument } from "../models/Collection.js";
import { AppError } from "../utils/AppError.js";
import { uniqueSlug } from "../utils/slug.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";

/**
 * Collection business logic. Soft `isActive` flag; admin mutations audited.
 */

const MODULE = "Colecciones";

interface CreateCollectionInput {
  name: string;
  description?: string;
  heroMedia?: { image?: string; video?: string };
  isActive?: boolean;
  sortOrder?: number;
}

type UpdateCollectionInput = Partial<CreateCollectionInput>;

const listPublic = (): Promise<CollectionDocument[]> =>
  Collection.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).exec();

const adminList = (): Promise<CollectionDocument[]> =>
  Collection.find().sort({ sortOrder: 1, name: 1 }).exec();

const getBySlug = async (slug: string): Promise<CollectionDocument> => {
  const collection = await Collection.findOne({ slug, isActive: true });
  if (!collection) {
    throw new AppError("Colección no encontrada", 404);
  }
  return collection;
};

const adminGet = async (id: string): Promise<CollectionDocument> => {
  const collection = await Collection.findById(id);
  if (!collection) {
    throw new AppError("Colección no encontrada", 404);
  }
  return collection;
};

const create = async (input: CreateCollectionInput, actor: Actor): Promise<CollectionDocument> => {
  const slug = await uniqueSlug(Collection, input.name);
  const collection = await Collection.create({ ...input, slug });
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "CREATE",
    module: MODULE,
    targetId: collection.id as string,
    after: collection.toObject(),
    ip: actor.ip,
  });
  return collection;
};

const update = async (
  id: string,
  input: UpdateCollectionInput,
  actor: Actor,
): Promise<CollectionDocument> => {
  const collection = await adminGet(id);
  const before = collection.toObject();
  Object.assign(collection, input);
  await collection.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "UPDATE",
    module: MODULE,
    targetId: collection.id as string,
    before,
    after: collection.toObject(),
    ip: actor.ip,
  });
  return collection;
};

const remove = async (id: string, actor: Actor): Promise<void> => {
  const collection = await adminGet(id);
  collection.isActive = false;
  await collection.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ARCHIVE",
    module: MODULE,
    targetId: collection.id as string,
    ip: actor.ip,
  });
};

export type { CreateCollectionInput, UpdateCollectionInput };
export { listPublic, adminList, getBySlug, adminGet, create, update, remove };
