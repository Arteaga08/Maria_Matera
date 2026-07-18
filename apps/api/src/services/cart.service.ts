import type { ClientSession, Types } from "mongoose";
import type { PricedCart, PricedCartItem } from "@maria-matera/shared";
import { Cart, type CartDocument } from "../models/Cart.js";
import { Product } from "../models/Product.js";
import { ProductVariant } from "../models/ProductVariant.js";
import { AppError } from "../utils/AppError.js";
import * as settingsService from "./settings.service.js";

/**
 * Cart business logic. The cart document only ever stores refs + qty — never
 * a price — so `getPriced` is the single source of truth for money: it
 * always reads `Product.priceCents` fresh from the catalog. B2C-only: one
 * price per product, no wholesale tiers, no promotions/coupons here (that's
 * a later task).
 */

interface AddItemInput {
  productId: string;
  variantId: string;
  qty: number;
}

const getOrCreateCart = async (customerId: string): Promise<CartDocument> => {
  const existing = await Cart.findOne({ customerId });
  if (existing) {
    return existing;
  }
  return Cart.create({ customerId, items: [] });
};

/** Validates the referenced product/variant are real, published, catalog-purchasable. */
const assertCatalogAvailable = async (
  productId: string,
  variantId: string,
): Promise<{ sku: string; productId: Types.ObjectId; variantId: Types.ObjectId }> => {
  const product = await Product.findOne({
    _id: productId,
    isPublished: true,
    isArchived: false,
  });
  if (!product) {
    throw new AppError("El producto no existe o no está disponible.", 400);
  }
  const variant = await ProductVariant.findOne({ _id: variantId, productId, isArchived: false });
  if (!variant) {
    throw new AppError("La variante seleccionada no existe o no está disponible.", 400);
  }
  return { sku: variant.sku, productId: product._id, variantId: variant._id };
};

const findItemOrThrow = (cart: CartDocument, itemId: string) => {
  const item = cart.items.id(itemId);
  if (!item) {
    throw new AppError("Artículo no encontrado en el carrito.", 404);
  }
  return item;
};

const addItem = async (customerId: string, input: AddItemInput): Promise<CartDocument> => {
  const { sku, productId, variantId } = await assertCatalogAvailable(
    input.productId,
    input.variantId,
  );
  const cart = await getOrCreateCart(customerId);

  const existingItem = cart.items.find(
    (item) =>
      item.productId.toString() === input.productId &&
      item.variantId.toString() === input.variantId,
  );
  if (existingItem) {
    existingItem.qty += input.qty;
  } else {
    cart.items.push({ productId, variantId, sku, qty: input.qty });
  }

  await cart.save();
  return cart;
};

const updateQty = async (
  customerId: string,
  itemId: string,
  qty: number,
): Promise<CartDocument> => {
  const cart = await getOrCreateCart(customerId);
  const item = findItemOrThrow(cart, itemId);
  item.qty = qty;
  await cart.save();
  return cart;
};

const removeItem = async (customerId: string, itemId: string): Promise<CartDocument> => {
  const cart = await getOrCreateCart(customerId);
  findItemOrThrow(cart, itemId);
  cart.items.pull({ _id: itemId });
  await cart.save();
  return cart;
};

/**
 * Empties the customer's cart. Accepts an optional `session` so it can run
 * inside `orderService.createOrder`'s transaction (cart clearing must roll back
 * with the rest of the order if anything downstream fails). Without a session it
 * behaves exactly as before.
 */
const clear = async (customerId: string, session?: ClientSession): Promise<void> => {
  if (session) {
    if (!session.inTransaction()) {
      throw new AppError("clear debe ejecutarse dentro de una transacción.", 500);
    }
    const cart = await Cart.findOne({ customerId }).session(session);
    if (cart) {
      cart.items.splice(0, cart.items.length);
      await cart.save({ session });
    }
    return;
  }
  const cart = await getOrCreateCart(customerId);
  cart.items.splice(0, cart.items.length);
  await cart.save();
};

/**
 * Builds the priced view of a customer's cart. Every line's price comes from
 * the *live* `Product.priceCents` — the cart document never stores one.
 *
 * Judgment call: if a product/variant was unpublished, archived, or deleted
 * after being added to the cart, its live catalog state now says it's not
 * purchasable — such lines are silently excluded from the priced view (and
 * from the subtotal). The cart document itself is left untouched, so the
 * line reappears automatically if the product is republished later.
 */
const getPriced = async (customerId: string): Promise<PricedCart> => {
  const cart = await getOrCreateCart(customerId);

  // Batch both lookups (one round-trip each) instead of a per-line await —
  // a cart with N lines must not cost 2N sequential DB round-trips.
  const productIds = cart.items.map((item) => item.productId);
  const variantIds = cart.items.map((item) => item.variantId);

  const [products, variants] = await Promise.all([
    Product.find({ _id: { $in: productIds }, isPublished: true, isArchived: false }),
    ProductVariant.find({ _id: { $in: variantIds }, isArchived: false }),
  ]);

  const productById = new Map(products.map((product) => [product._id.toString(), product]));
  const variantById = new Map(variants.map((variant) => [variant._id.toString(), variant]));

  const items: PricedCartItem[] = [];
  let subtotalCents = 0;

  for (const item of cart.items) {
    const product = productById.get(item.productId.toString());
    if (!product) {
      continue;
    }
    const variant = variantById.get(item.variantId.toString());
    if (!variant) {
      continue;
    }

    const linePriceCents = product.priceCents * item.qty;
    subtotalCents += linePriceCents;
    items.push({
      itemId: item._id.toString(),
      productId: item.productId.toString(),
      variantId: item.variantId.toString(),
      sku: item.sku,
      qty: item.qty,
      name: product.name,
      unitPriceCents: product.priceCents,
      linePriceCents,
    });
  }

  const settings = await settingsService.get();
  const shippingCostCents =
    subtotalCents >= settings.freeShippingThreshold ? 0 : settings.shippingFlatFee;

  return {
    items,
    subtotalCents,
    shippingCostCents,
    totalCents: subtotalCents + shippingCostCents,
  };
};

export type { AddItemInput };
export { getOrCreateCart as getOrCreate, addItem, updateQty, removeItem, clear, getPriced };
