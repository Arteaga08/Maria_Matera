/**
 * Cart DTO shapes shared by API and web. B2C retail only — single price per
 * product/variant, no wholesale/tier pricing, no promotions engine here.
 *
 * `itemId` (added in Milestone 5 / Task 2, alongside the cart implementation)
 * is the cart line's own subdocument id — required so a client can address a
 * specific line for `PATCH/DELETE /api/v1/cart/items/:itemId` at all.
 */

interface CartItem {
  itemId: string;
  productId: string;
  variantId: string;
  sku: string;
  qty: number;
}

interface PricedCartItem extends CartItem {
  name: string;
  unitPriceCents: number;
  linePriceCents: number;
}

interface PricedCart {
  items: PricedCartItem[];
  subtotalCents: number;
  shippingCostCents: number;
  totalCents: number;
}

export type { CartItem, PricedCartItem, PricedCart };
