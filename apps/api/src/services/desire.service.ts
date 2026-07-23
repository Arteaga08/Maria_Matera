import type { Types } from "mongoose";
import { ProductViewEvent } from "../models/ProductViewEvent.js";
import { Product } from "../models/Product.js";
import { Customer } from "../models/Customer.js";
import { Order } from "../models/Order.js";
import { REALIZED_SALE_STATUSES } from "./order.service.js";
import { parseStatsRange, type StatsRangeQuery } from "../utils/statsRange.js";

/**
 * Desire analysis (views vs wishlist vs purchases). Ingest is anonymous and
 * silent on unknown/unsellable products (anti catalog-enumeration, keeps bot
 * junk out of the data). The admin analysis merges four independent parallel
 * queries in memory — the jewelry catalog is small, and this stays simpler
 * and more testable than a triple `$lookup` pipeline.
 */

const STATS_DEFAULT_RANGE_DAYS = 30;

interface DesireRow {
  productId: string;
  name: string;
  slug: string;
  isPublished: boolean;
  views: number;
  wishlistCount: number;
  unitsSold: number;
  revenueCents: number;
  /** unitsSold / views, one decimal; null when there are no views to convert. */
  conversionPercent: number | null;
}

interface DesireStats {
  rangeFrom: Date;
  rangeTo: Date;
  products: DesireRow[];
}

interface CountRow {
  _id: Types.ObjectId;
  count: number;
}

interface SalesRow {
  _id: Types.ObjectId;
  unitsSold: number;
  revenueCents: number;
}

/**
 * Records one anonymous view. Responds identically whether the product was
 * persisted or not — a valid-shaped id for a missing/unpublished/archived
 * product is a silent no-op by design.
 */
const recordProductView = async (productId: string): Promise<void> => {
  const product = await Product.findOne({
    _id: productId,
    isPublished: true,
    isArchived: false,
  })
    .select("_id")
    .lean();
  if (!product) return;
  await ProductViewEvent.create({ productId: product._id });
};

const adminDesire = async (query: StatsRangeQuery): Promise<DesireStats> => {
  const { from, to } = parseStatsRange(query, STATS_DEFAULT_RANGE_DAYS);

  const [viewRows, wishlistRows, salesRows, products] = await Promise.all([
    ProductViewEvent.aggregate<CountRow>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: "$productId", count: { $sum: 1 } } },
    ]),
    // Wishlist is current state (a standing desire signal), not range-scoped.
    Customer.aggregate<CountRow>([
      { $unwind: "$wishlist" },
      { $group: { _id: "$wishlist", count: { $sum: 1 } } },
    ]),
    Order.aggregate<SalesRow>([
      {
        $match: {
          status: { $in: REALIZED_SALE_STATUSES },
          createdAt: { $gte: from, $lt: to },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          unitsSold: { $sum: "$items.qty" },
          revenueCents: { $sum: "$items.lineSubtotalCents" },
        },
      },
    ]),
    // Archived products are excluded (terminal decision, noise); unpublished
    // ones stay in with their flag — accumulated desire with zero sales is
    // exactly the insight this page exists for.
    Product.find({ isArchived: false }).select("name slug isPublished").lean(),
  ]);

  const views = new Map(viewRows.map((r) => [String(r._id), r.count]));
  const wishlists = new Map(wishlistRows.map((r) => [String(r._id), r.count]));
  const sales = new Map(salesRows.map((r) => [String(r._id), r]));

  const rows: DesireRow[] = products
    .map((product) => {
      const id = String(product._id);
      const productViews = views.get(id) ?? 0;
      const sold = sales.get(id);
      const unitsSold = sold?.unitsSold ?? 0;
      return {
        productId: id,
        name: product.name,
        slug: product.slug,
        isPublished: product.isPublished,
        views: productViews,
        wishlistCount: wishlists.get(id) ?? 0,
        unitsSold,
        revenueCents: sold?.revenueCents ?? 0,
        conversionPercent:
          productViews > 0 ? Math.round((unitsSold / productViews) * 1000) / 10 : null,
      };
    })
    .filter((row) => row.views > 0 || row.wishlistCount > 0 || row.unitsSold > 0)
    .sort(
      (a, b) =>
        b.views - a.views ||
        b.wishlistCount - a.wishlistCount ||
        a.productId.localeCompare(b.productId),
    );

  return { rangeFrom: from, rangeTo: to, products: rows };
};

export type { DesireRow, DesireStats };
export { recordProductView, adminDesire };
