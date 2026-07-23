import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import * as productService from "../../src/services/product.service.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Category } from "../../src/models/Category.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import type { Actor } from "../../src/utils/actor.js";

/**
 * Service-level characterization of `product.service.ts` (previously only
 * exercised indirectly via `catalog.test.ts`, 5 HTTP cases). Pure
 * characterization — no fixes here. Several gaps documented
 * (`// documented gap, not a guard`): none block or cascade anything, they
 * just pin the current behavior.
 */

const actor: Actor = { id: new mongoose.Types.ObjectId().toString(), ip: "127.0.0.1" };
let counter = 0;

const makeCategory = async (overrides: Partial<{ skuPrefix: string; slug: string }> = {}) => {
  counter += 1;
  return Category.create({
    name: `Categoría producto ${counter}`,
    slug: overrides.slug ?? `categoria-producto-${counter}`,
    skuPrefix: overrides.skuPrefix ?? `PRD${counter}`,
  });
};

const makeInput = (
  categoryId: mongoose.Types.ObjectId,
  overrides: Partial<{
    name: string;
    collectionId: string;
    priceCents: number;
    material: string;
    stone: { type?: string; carat?: number };
  }> = {},
) => {
  counter += 1;
  return {
    name: overrides.name ?? `Anillo ${counter}`,
    description: "Producto de prueba",
    categoryId: String(categoryId),
    collectionId: overrides.collectionId,
    priceCents: overrides.priceCents ?? 100000,
    material: overrides.material,
    stone: overrides.stone,
  };
};

describe("product.service create", () => {
  it("generates a unique slug and a default variant with an auto-generated SKU", async () => {
    const category = await makeCategory({ skuPrefix: "CRE" });

    const first = await productService.create(makeInput(category._id as mongoose.Types.ObjectId, { name: "Aro" }), actor);
    const second = await productService.create(makeInput(category._id as mongoose.Types.ObjectId, { name: "Aro" }), actor);

    expect(second.product.slug).not.toBe(first.product.slug);
    expect(first.variants).toHaveLength(1);
    expect(first.variants[0]!.sku).toMatch(/^CRE-\d{4}$/);
  });

  it("400s with 'Categoría no válida' when categoryId does not exist", async () => {
    await expect(
      productService.create(
        makeInput(new mongoose.Types.ObjectId(), { name: "Fantasma" }),
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("400s with 'Colección no válida' when collectionId is provided but does not exist", async () => {
    const category = await makeCategory();
    const input = makeInput(category._id as mongoose.Types.ObjectId, {
      collectionId: new mongoose.Types.ObjectId().toString(),
    });

    await expect(productService.create(input, actor)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("succeeds without a collectionId (optional field, no validation triggered)", async () => {
    const category = await makeCategory();

    await expect(
      productService.create(makeInput(category._id as mongoose.Types.ObjectId), actor),
    ).resolves.toBeDefined();
  });

  it("writes exactly one AuditLog entry for the product (not one for the auto-created variant)", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );

    const entries = await AuditLog.find({ module: "Productos", targetId: product.id as string });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("CREATE");

    const variantAudits = await AuditLog.find({ module: "Variantes" });
    expect(variantAudits).toHaveLength(0);
  });
});

describe("product.service listPublic", () => {
  it("only returns published, non-archived products", async () => {
    const category = await makeCategory();
    const { product: published } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(published.id as string, true, actor);

    const { product: unpublished } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );

    const { product: archived } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(archived.id as string, true, actor);
    await productService.archive(archived.id as string, actor);

    const result = await productService.listPublic({});
    const ids = result.items.map((p) => String(p._id));

    expect(ids).toContain(String(published._id));
    expect(ids).not.toContain(String(unpublished._id));
    expect(ids).not.toContain(String(archived._id));
  });

  it("filters by category slug", async () => {
    const categoryA = await makeCategory();
    const categoryB = await makeCategory();
    const { product: inA } = await productService.create(
      makeInput(categoryA._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(inA.id as string, true, actor);
    const { product: inB } = await productService.create(
      makeInput(categoryB._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(inB.id as string, true, actor);

    const result = await productService.listPublic({ category: categoryA.slug });

    expect(result.items.map((p) => String(p._id))).toEqual([String(inA._id)]);
  });

  it("documented gap, not a guard: filtering by an unknown category slug returns an empty list, not a 400", async () => {
    const result = await productService.listPublic({ category: "no-existe-jamas" });

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it("filters by material, stone type, and price range (in pesos, converted to cents)", async () => {
    const category = await makeCategory();
    const { product: gold } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId, {
        material: "oro",
        priceCents: 500000,
        stone: { type: "diamante" },
      }),
      actor,
    );
    await productService.setPublished(gold.id as string, true, actor);
    const { product: silver } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId, { material: "plata", priceCents: 50000 }),
      actor,
    );
    await productService.setPublished(silver.id as string, true, actor);

    const byMaterial = await productService.listPublic({ material: "oro" });
    expect(byMaterial.items.map((p) => String(p._id))).toEqual([String(gold._id)]);

    const byStone = await productService.listPublic({ stone: "diamante" });
    expect(byStone.items.map((p) => String(p._id))).toEqual([String(gold._id)]);

    const byPriceRange = await productService.listPublic({ priceMin: "4000", priceMax: "6000" });
    expect(byPriceRange.items.map((p) => String(p._id))).toEqual([String(gold._id)]);
  });

  it("sorts by price ascending/descending via the 'price' alias, remapped to priceCents", async () => {
    const category = await makeCategory();
    const { product: cheap } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId, { priceCents: 10000 }),
      actor,
    );
    await productService.setPublished(cheap.id as string, true, actor);
    const { product: expensive } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId, { priceCents: 900000 }),
      actor,
    );
    await productService.setPublished(expensive.id as string, true, actor);

    const ascending = await productService.listPublic({ sort: "price" });
    expect(ascending.items.map((p) => String(p._id))).toEqual([String(cheap._id), String(expensive._id)]);

    const descending = await productService.listPublic({ sort: "-price" });
    expect(descending.items.map((p) => String(p._id))).toEqual([String(expensive._id), String(cheap._id)]);
  });

  it("paginates with a coherent meta block", async () => {
    const category = await makeCategory();
    for (let i = 0; i < 3; i += 1) {
      const { product } = await productService.create(
        makeInput(category._id as mongoose.Types.ObjectId),
        actor,
      );
      await productService.setPublished(product.id as string, true, actor);
    }

    const result = await productService.listPublic({ page: "1", pageSize: "2" });

    expect(result.items).toHaveLength(2);
    expect(result.meta).toMatchObject({ page: 1, pageSize: 2, total: 3 });
  });
});

describe("product.service getBySlugPublic", () => {
  it("returns only non-archived variants alongside the product", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(product.id as string, true, actor);
    const extraVariant = await ProductVariant.create({
      productId: product._id,
      sku: `${category.skuPrefix}-EXTRA`,
      isArchived: true,
    });

    const result = await productService.getBySlugPublic(product.slug);

    const variantIds = result.variants.map((v) => String(v._id));
    expect(variantIds).not.toContain(String(extraVariant._id));
    expect(variantIds.length).toBeGreaterThanOrEqual(1);
  });

  it("documented gap, not a guard: an archived or unpublished product 404s identically to a nonexistent slug", async () => {
    const category = await makeCategory();
    const { product: unpublished } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    const { product: archived } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(archived.id as string, true, actor);
    await productService.archive(archived.id as string, actor);

    await expect(productService.getBySlugPublic(unpublished.slug)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(productService.getBySlugPublic(archived.slug)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(productService.getBySlugPublic("no-existe")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("product.service adminList / adminGet", () => {
  it("adminList returns products in every state, no filter applied", async () => {
    const category = await makeCategory();
    const { product: unpublished } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    const { product: archived } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.archive(archived.id as string, actor);

    const result = await productService.adminList({});
    const ids = result.items.map((p) => String(p._id));

    expect(ids).toContain(String(unpublished._id));
    expect(ids).toContain(String(archived._id));
  });

  it("adminGet returns every variant, including archived ones (unlike getBySlugPublic)", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    const archivedVariant = await ProductVariant.create({
      productId: product._id,
      sku: `${category.skuPrefix}-ARCH`,
      isArchived: true,
    });

    const result = await productService.adminGet(product.id as string);

    expect(result.variants.map((v) => String(v._id))).toContain(String(archivedVariant._id));
  });

  it("adminGet 404s for a nonexistent id", async () => {
    await expect(
      productService.adminGet(new mongoose.Types.ObjectId().toString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("product.service update", () => {
  it("validates categoryId/collectionId only when present in the partial input", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );

    // No categoryId/collectionId in the input at all — no reference check runs.
    await expect(
      productService.update(product.id as string, { name: "Nombre nuevo" }, actor),
    ).resolves.toBeDefined();

    // An invalid categoryId IS validated when present.
    await expect(
      productService.update(
        product.id as string,
        { categoryId: new mongoose.Types.ObjectId().toString() },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("documented gap, not a guard: renaming the product does not regenerate its slug", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId, { name: "Nombre Original" }),
      actor,
    );
    const originalSlug = product.slug;

    const updated = await productService.update(
      product.id as string,
      { name: "Nombre Completamente Distinto" },
      actor,
    );

    expect(updated.slug).toBe(originalSlug); // desynced from the new name
  });

  it("audits UPDATE with before/after; 404s for a nonexistent id", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );

    await productService.update(product.id as string, { material: "platino" }, actor);

    const audit = await AuditLog.findOne({ module: "Productos", action: "UPDATE", targetId: product.id as string });
    expect(audit!.before).toBeDefined();
    expect(audit!.after).toBeDefined();

    await expect(
      productService.update(new mongoose.Types.ObjectId().toString(), { material: "x" }, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("product.service setPublished", () => {
  it("toggles isPublished and audits PUBLISH/UNPUBLISH accordingly", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );

    const published = await productService.setPublished(product.id as string, true, actor);
    expect(published.isPublished).toBe(true);
    expect(
      await AuditLog.findOne({ module: "Productos", action: "PUBLISH", targetId: product.id as string }),
    ).not.toBeNull();

    const unpublished = await productService.setPublished(product.id as string, false, actor);
    expect(unpublished.isPublished).toBe(false);
    expect(
      await AuditLog.findOne({ module: "Productos", action: "UNPUBLISH", targetId: product.id as string }),
    ).not.toBeNull();
  });

  it("documented gap, not a guard: republishing an archived product leaves isArchived:true + isPublished:true simultaneously", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.archive(product.id as string, actor);

    const republished = await productService.setPublished(product.id as string, true, actor);

    expect(republished.isArchived).toBe(true);
    expect(republished.isPublished).toBe(true); // inconsistent internal state, no guard against it
  });

  it("404s for a nonexistent id", async () => {
    await expect(
      productService.setPublished(new mongoose.Types.ObjectId().toString(), true, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("product.service archive", () => {
  it("sets isArchived AND isPublished:false in the same call, and audits ARCHIVE", async () => {
    const category = await makeCategory();
    const { product } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );
    await productService.setPublished(product.id as string, true, actor);

    await productService.archive(product.id as string, actor);

    const reloaded = await Product.findById(product.id as string);
    expect(reloaded!.isArchived).toBe(true);
    expect(reloaded!.isPublished).toBe(false);
    expect(
      await AuditLog.findOne({ module: "Productos", action: "ARCHIVE", targetId: product.id as string }),
    ).not.toBeNull();
  });

  it("documented gap, not a guard: does not cascade-archive the product's variants", async () => {
    const category = await makeCategory();
    const { product, variants } = await productService.create(
      makeInput(category._id as mongoose.Types.ObjectId),
      actor,
    );

    await productService.archive(product.id as string, actor);

    const reloadedVariant = await ProductVariant.findById(variants[0]!.id as string);
    expect(reloadedVariant!.isArchived).toBe(false); // orphaned, still "active"
  });

  it("404s for a nonexistent id", async () => {
    await expect(
      productService.archive(new mongoose.Types.ObjectId().toString(), actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
