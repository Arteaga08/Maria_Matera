import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import * as variantService from "../../src/services/variant.service.js";
import { Product } from "../../src/models/Product.js";
import { Category } from "../../src/models/Category.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import type { Actor } from "../../src/utils/actor.js";

/**
 * Service-level characterization of `variant.service.ts` (zero prior test
 * coverage). Pure characterization — no fixes here. Several gaps are
 * documented (`// documented gap, not a guard`): none block or cascade
 * anything, they just record current behavior for future refactors.
 */

const actor: Actor = { id: new mongoose.Types.ObjectId().toString(), ip: "127.0.0.1" };
let counter = 0;

const makeCategory = async (skuPrefix?: string) => {
  counter += 1;
  return Category.create({
    name: `Categoría variante ${counter}`,
    slug: `categoria-variante-${counter}`,
    skuPrefix: skuPrefix ?? `VAR${counter}`,
  });
};

const makeProduct = async (categoryId: mongoose.Types.ObjectId) => {
  counter += 1;
  return Product.create({
    name: `Producto variante ${counter}`,
    slug: `producto-variante-${counter}`,
    description: "Producto de prueba",
    categoryId,
    priceCents: 100000,
  });
};

describe("variant.service addVariant", () => {
  it("auto-generates the SKU from the product's category prefix and audits CREATE", async () => {
    const category = await makeCategory("RNG");
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);

    const variant = await variantService.addVariant(product.id as string, { size: "7" }, actor);

    expect(variant.sku).toMatch(/^RNG-\d{4}$/);
    expect(variant.size).toBe("7");

    const audit = await AuditLog.findOne({ module: "Variantes", action: "CREATE", targetId: variant.id });
    expect(audit).not.toBeNull();
    expect(audit!.after).toBeDefined();
  });

  it("increments the SKU sequence for a second variant under the same category", async () => {
    const category = await makeCategory("SEQ");
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);

    const first = await variantService.addVariant(product.id as string, {}, actor);
    const second = await variantService.addVariant(product.id as string, {}, actor);

    expect(first.sku).toBe("SEQ-0001");
    expect(second.sku).toBe("SEQ-0002");
  });

  it("404s when the parent product does not exist", async () => {
    await expect(
      variantService.addVariant(new mongoose.Types.ObjectId().toString(), {}, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("documented gap, not a guard: 400s via generateVariantSku if the product's category was deleted", async () => {
    const category = await makeCategory("GONE");
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);
    await Category.deleteOne({ _id: category._id });

    await expect(variantService.addVariant(product.id as string, {}, actor)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("variant.service updateVariant", () => {
  it("merges partial input, leaving untouched fields intact, and audits UPDATE with before/after", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);
    const variant = await variantService.addVariant(
      product.id as string,
      { size: "7", material: "oro" },
      actor,
    );

    const updated = await variantService.updateVariant(variant.id as string, { size: "8" }, actor);

    expect(updated.size).toBe("8");
    expect(updated.material).toBe("oro"); // untouched field survives

    const audit = await AuditLog.findOne({ module: "Variantes", action: "UPDATE", targetId: variant.id });
    expect(audit!.before).toBeDefined();
    expect(audit!.after).toBeDefined();
  });

  it("404s when the variant does not exist", async () => {
    await expect(
      variantService.updateVariant(new mongoose.Types.ObjectId().toString(), { size: "9" }, actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("documented gap, not a guard: does NOT regenerate the SKU if the parent product moves to another category", async () => {
    const categoryA = await makeCategory("AAA");
    const categoryB = await makeCategory("BBB");
    const product = await makeProduct(categoryA._id as mongoose.Types.ObjectId);
    const variant = await variantService.addVariant(product.id as string, {}, actor);
    expect(variant.sku).toMatch(/^AAA-/);

    await Product.updateOne({ _id: product._id }, { $set: { categoryId: categoryB._id } });
    const updated = await variantService.updateVariant(variant.id as string, { size: "7" }, actor);

    expect(updated.sku).toMatch(/^AAA-/); // still the old prefix — desynced from the product's new category
  });

  it("documented gap, not a guard: can update a variant whose parent product is already archived", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);
    const variant = await variantService.addVariant(product.id as string, {}, actor);
    await Product.updateOne({ _id: product._id }, { $set: { isArchived: true } });

    await expect(
      variantService.updateVariant(variant.id as string, { size: "9" }, actor),
    ).resolves.toBeDefined();
  });
});

describe("variant.service archiveVariant", () => {
  it("only flips isArchived, leaving the rest of the variant intact, and audits ARCHIVE", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);
    const variant = await variantService.addVariant(
      product.id as string,
      { size: "7", material: "plata" },
      actor,
    );

    await variantService.archiveVariant(variant.id as string, actor);

    const reloaded = await ProductVariant.findById(variant.id as string);
    expect(reloaded!.isArchived).toBe(true);
    expect(reloaded!.material).toBe("plata");

    const audit = await AuditLog.findOne({ module: "Variantes", action: "ARCHIVE", targetId: variant.id });
    expect(audit).not.toBeNull();
  });

  it("404s when the variant does not exist", async () => {
    await expect(
      variantService.archiveVariant(new mongoose.Types.ObjectId().toString(), actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("documented gap, not a guard: does not check pending stock/reservations before archiving", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);
    const variant = await variantService.addVariant(product.id as string, {}, actor);
    await ProductVariant.updateOne(
      { _id: variant._id },
      { $set: { onHand: 10, reserved: 5 } },
    );

    await expect(variantService.archiveVariant(variant.id as string, actor)).resolves.toBeUndefined();
  });

  it("documented gap, not a guard: archiving the product's only active variant does not unpublish the product", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category._id as mongoose.Types.ObjectId);
    await Product.updateOne({ _id: product._id }, { $set: { isPublished: true } });
    const variant = await variantService.addVariant(product.id as string, {}, actor);

    await variantService.archiveVariant(variant.id as string, actor);

    const reloadedProduct = await Product.findById(product._id);
    expect(reloadedProduct!.isPublished).toBe(true); // still published, now with zero active variants
  });
});
