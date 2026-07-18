/**
 * Order DTO shapes shared by API and web. Items are point-in-time snapshots
 * (name/price captured at purchase) so later catalog changes never mutate
 * historical orders.
 */

import type { OrderStatus } from "../enums.js";

interface OrderItem {
  productId: string;
  variantId: string;
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
}

interface StatusHistoryEntry {
  from: OrderStatus;
  to: OrderStatus;
  by: string;
  reason?: string;
  at: Date;
}

export type { OrderItem, StatusHistoryEntry };
