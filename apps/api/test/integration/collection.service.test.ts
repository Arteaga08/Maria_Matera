import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import * as collectionService from "../../src/services/collection.service.js";
import { Collection } from "../../src/models/Collection.js";
import { Category } from "../../src/models/Category.js";
import { Product } from "../../src/models/Product.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import type { Actor } from "../../src/utils/actor.js";

/**
 * Service-level characterization of `collection.service.ts`. Same skeleton as
 * `category.service.test.ts`, without the skuPrefix case (Collection has no
 * unique field besides slug). One real gap is fixed here (TDD): `remove` used
 * to silently orphan active products via the optional `collectionId`.
 */

const actor: Actor = { id: new mongoose.Types.ObjectId().toString(), ip: "127.0.0.1" };
let counter = 0;

const makeInput = (overrides: Partial<{ name: string }> = {}) => {
  counter += 1;
  return { name: overrides.name ?? `Verano ${counter}` };
};

const makeCategory = async () => {
  counter += 1;
  return Category.create({
    name: `Categoría col ${counter}`,
    slug: `categoria-col-${counter}`,
    skuPrefix: `COL${counter}`,
  });
};

describe("collection.service listPublic / adminList", () => {
  it("listPublic returns only active collections; adminList returns all", async () => {
    const active = await collectionService.create(makeInput(), actor);
    const inactive = await collectionService.create(makeInput(), actor);
    await collectionService.remove(inactive.id as string, actor);

    const publicList = await collectionService.listPublic();
    const adminAll = await collectionService.adminList();

    expect(publicList.map((c) => c.id)).toContain(active.id);
    expect(publicList.map((c) => c.id)).not.toContain(inactive.id);
    expect(adminAll.map((c) => c.id)).toContain(inactive.id);
  });
});

describe("collection.service getBySlug / adminGet", () => {
  it("getBySlug 404s for unknown or inactive collections", async () => {
    await expect(collectionService.getBySlug("no-existe")).rejects.toMatchObject({
      statusCode: 404,
    });

    const collection = await collectionService.create(makeInput(), actor);
    await collectionService.remove(collection.id as string, actor);
    await expect(collectionService.getBySlug(collection.slug)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("adminGet ignores state and 404s only when missing", async () => {
    const collection = await collectionService.create(makeInput(), actor);
    await collectionService.remove(collection.id as string, actor);

    const found = await collectionService.adminGet(collection.id as string);
    expect(found.isActive).toBe(false);

    await expect(
      collectionService.adminGet(new mongoose.Types.ObjectId().toString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("collection.service create / update", () => {
  it("auto-generates a unique slug and audits CREATE", async () => {
    const first = await collectionService.create(makeInput({ name: "Novias" }), actor);
    const second = await collectionService.create(makeInput({ name: "Novias" }), actor);

    expect(second.slug).not.toBe(first.slug);

    const audit = await AuditLog.findOne({ module: "Colecciones", action: "CREATE", targetId: first.id });
    expect(audit).not.toBeNull();
  });

  it("update merges partial input and audits UPDATE with before/after; 404s if missing", async () => {
    const collection = await collectionService.create(makeInput(), actor);

    const updated = await collectionService.update(
      collection.id as string,
      { description: "Colección de verano" },
      actor,
    );
    expect(updated.description).toBe("Colección de verano");

    const audit = await AuditLog.findOne({ module: "Colecciones", action: "UPDATE" });
    expect(audit!.before).toBeDefined();
    expect(audit!.after).toBeDefined();

    await expect(
      collectionService.update(new mongoose.Types.ObjectId().toString(), { description: "x" }, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("documented gap, not a guard: update operates on an already-removed collection", async () => {
    const collection = await collectionService.create(makeInput(), actor);
    await collectionService.remove(collection.id as string, actor);

    const updated = await collectionService.update(
      collection.id as string,
      { description: "Editada tras remove" },
      actor,
    );
    expect(updated.isActive).toBe(false);
  });
});

describe("collection.service remove", () => {
  it("soft-archives without hard-deleting and audits action ARCHIVE", async () => {
    const collection = await collectionService.create(makeInput(), actor);

    await collectionService.remove(collection.id as string, actor);

    const stillExists = await Collection.findById(collection.id as string);
    expect(stillExists!.isActive).toBe(false);

    const audit = await AuditLog.findOne({
      module: "Colecciones",
      targetId: collection.id as string,
      action: "ARCHIVE",
    });
    expect(audit).not.toBeNull();
  });

  it("404s when the collection does not exist", async () => {
    await expect(
      collectionService.remove(new mongoose.Types.ObjectId().toString(), actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("succeeds with no active products referencing it (happy path preserved)", async () => {
    const collection = await collectionService.create(makeInput(), actor);
    await expect(collectionService.remove(collection.id as string, actor)).resolves.toBeUndefined();
  });

  it("FIX: rejects with 409 when an active product references the collection (optional collectionId)", async () => {
    const collection = await collectionService.create(makeInput(), actor);
    const category = await makeCategory();
    await Product.create({
      name: "Producto en colección",
      slug: `producto-coleccion-${counter}`,
      description: "Producto de prueba",
      categoryId: category._id,
      collectionId: collection._id,
      priceCents: 100000,
      isArchived: false,
    });

    await expect(collectionService.remove(collection.id as string, actor)).rejects.toMatchObject({
      statusCode: 409,
    });

    const stillActive = await Collection.findById(collection.id as string);
    expect(stillActive!.isActive).toBe(true);
  });

  it("FIX: an ARCHIVED product referencing the collection does NOT block removal", async () => {
    const collection = await collectionService.create(makeInput(), actor);
    const category = await makeCategory();
    await Product.create({
      name: "Producto archivado en colección",
      slug: `producto-archivado-coleccion-${counter}`,
      description: "Producto de prueba",
      categoryId: category._id,
      collectionId: collection._id,
      priceCents: 100000,
      isArchived: true,
    });

    await expect(collectionService.remove(collection.id as string, actor)).resolves.toBeUndefined();
  });
});
