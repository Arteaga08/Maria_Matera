import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import * as categoryService from "../../src/services/category.service.js";
import type { Actor } from "../../src/services/category.service.js";
import { Category } from "../../src/models/Category.js";
import { Product } from "../../src/models/Product.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { AppError } from "../../src/utils/AppError.js";

/**
 * Service-level characterization of `category.service.ts`, direct calls (no
 * HTTP). Two real gaps are fixed here (TDD, not just characterization):
 * a duplicate `skuPrefix` used to leak a raw Mongo E11000 error, and `remove`
 * used to silently orphan active products. Everything else documents current
 * behavior as-is — see `// documented gap, not a guard` comments.
 */

const actor: Actor = { id: new mongoose.Types.ObjectId().toString(), ip: "127.0.0.1" };
let counter = 0;

const makeInput = (overrides: Partial<{ name: string; skuPrefix: string }> = {}) => {
  counter += 1;
  return {
    name: overrides.name ?? `Anillos ${counter}`,
    skuPrefix: overrides.skuPrefix ?? `RNG${counter}`,
  };
};

describe("category.service listPublic / adminList", () => {
  it("listPublic returns only active categories; adminList returns all", async () => {
    const active = await categoryService.create(makeInput(), actor);
    const inactive = await categoryService.create(makeInput(), actor);
    await categoryService.remove(inactive.id as string, actor);

    const publicList = await categoryService.listPublic();
    const adminAll = await categoryService.adminList();

    expect(publicList.map((c) => c.id)).toContain(active.id);
    expect(publicList.map((c) => c.id)).not.toContain(inactive.id);
    expect(adminAll.map((c) => c.id)).toContain(active.id);
    expect(adminAll.map((c) => c.id)).toContain(inactive.id);
  });
});

describe("category.service getBySlug / adminGet", () => {
  it("getBySlug 404s for an unknown slug", async () => {
    await expect(categoryService.getBySlug("no-existe")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("getBySlug 404s for an existing but inactive category", async () => {
    const category = await categoryService.create(makeInput(), actor);
    await categoryService.remove(category.id as string, actor);

    await expect(categoryService.getBySlug(category.slug)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("adminGet returns an inactive category (no state filter) and 404s only when missing", async () => {
    const category = await categoryService.create(makeInput(), actor);
    await categoryService.remove(category.id as string, actor);

    const found = await categoryService.adminGet(category.id as string);
    expect(found.isActive).toBe(false);

    await expect(
      categoryService.adminGet(new mongoose.Types.ObjectId().toString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("category.service create", () => {
  it("auto-generates a unique slug and audits CREATE", async () => {
    const first = await categoryService.create(makeInput({ name: "Pulseras" }), actor);
    const second = await categoryService.create(makeInput({ name: "Pulseras" }), actor);

    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toMatch(/^pulseras/);

    const audit = await AuditLog.findOne({ module: "Categorías", action: "CREATE", targetId: first.id });
    expect(audit).not.toBeNull();
    expect(audit!.after).toBeDefined();
  });

  it("FIX: a duplicate skuPrefix rejects with a friendly 400 AppError, not a raw Mongo error", async () => {
    const input = makeInput({ skuPrefix: "DUPE1" });
    await categoryService.create(input, actor);

    await expect(
      categoryService.create(makeInput({ skuPrefix: "DUPE1" }), actor),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      categoryService.create(makeInput({ skuPrefix: "DUPE1" }), actor),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("category.service update", () => {
  it("merges partial input and audits UPDATE with before/after", async () => {
    const category = await categoryService.create(makeInput(), actor);

    const updated = await categoryService.update(
      category.id as string,
      { description: "Nueva descripción" },
      actor,
    );

    expect(updated.description).toBe("Nueva descripción");
    expect(updated.skuPrefix).toBe(category.skuPrefix); // untouched fields survive

    const audit = await AuditLog.findOne({ module: "Categorías", action: "UPDATE" });
    expect(audit!.before).toBeDefined();
    expect(audit!.after).toBeDefined();
  });

  it("404s when the category does not exist", async () => {
    await expect(
      categoryService.update(new mongoose.Types.ObjectId().toString(), { description: "x" }, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("documented gap, not a guard: update operates on an already-removed (isActive:false) category", async () => {
    const category = await categoryService.create(makeInput(), actor);
    await categoryService.remove(category.id as string, actor);

    const updated = await categoryService.update(
      category.id as string,
      { description: "Editada tras remove" },
      actor,
    );

    expect(updated.description).toBe("Editada tras remove");
    expect(updated.isActive).toBe(false);
  });
});

describe("category.service remove", () => {
  it("soft-archives (isActive:false) without hard-deleting, and audits action ARCHIVE", async () => {
    const category = await categoryService.create(makeInput(), actor);

    await categoryService.remove(category.id as string, actor);

    const stillExists = await Category.findById(category.id as string);
    expect(stillExists).not.toBeNull();
    expect(stillExists!.isActive).toBe(false);

    const audit = await AuditLog.findOne({
      module: "Categorías",
      targetId: category.id as string,
      action: "ARCHIVE",
    }); // documented gap, not a guard: function is named "remove" but audits "ARCHIVE"
    expect(audit).not.toBeNull();
  });

  it("404s when the category does not exist", async () => {
    await expect(
      categoryService.remove(new mongoose.Types.ObjectId().toString(), actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("succeeds with no active products referencing it (happy path preserved)", async () => {
    const category = await categoryService.create(makeInput(), actor);

    await expect(categoryService.remove(category.id as string, actor)).resolves.toBeUndefined();
  });

  it("FIX: rejects with 409 when an active product references the category", async () => {
    const category = await categoryService.create(makeInput(), actor);
    await Product.create({
      name: "Anillo activo",
      slug: `anillo-activo-${counter}`,
      description: "Producto de prueba",
      categoryId: category._id,
      priceCents: 100000,
      isArchived: false,
    });

    await expect(categoryService.remove(category.id as string, actor)).rejects.toMatchObject({
      statusCode: 409,
    });

    const stillActive = await Category.findById(category.id as string);
    expect(stillActive!.isActive).toBe(true); // rejected before mutation
  });

  it("FIX: an ARCHIVED product referencing the category does NOT block removal", async () => {
    const category = await categoryService.create(makeInput(), actor);
    await Product.create({
      name: "Anillo archivado",
      slug: `anillo-archivado-${counter}`,
      description: "Producto de prueba",
      categoryId: category._id,
      priceCents: 100000,
      isArchived: true,
    });

    await expect(categoryService.remove(category.id as string, actor)).resolves.toBeUndefined();
  });
});
