import { Types } from "mongoose";
import { CustomerTier, OrderStatus, UserType } from "@maria-matera/shared";
import type { PaginationMeta } from "@maria-matera/shared";
import { Customer } from "../models/Customer.js";
import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { parseListQuery, buildMeta } from "../utils/listQuery.js";
import { parseStatsRange } from "../utils/statsRange.js";
import { recordAudit } from "./audit.service.js";
import { REALIZED_SALE_STATUSES } from "./order.service.js";

/**
 * Admin CRM read/stats module (Bloque 2 dashboard) plus the single CRM
 * mutation: the audited VIP-tier change. Spend figures always follow the
 * shared "realized sale" rule (`REALIZED_SALE_STATUSES` from order.service):
 * paid/processing/shipped/delivered count, refunded/cancelled/pending never do.
 * The customer's password hash never leaves this module (`select: false` on
 * the model plus explicit projections here).
 */

const MODULE = "crm";
const ADMIN_LIST_ALLOWED_SORT = ["createdAt", "totalSpentCents", "ordersCount"];
const TOP_CUSTOMERS_LIMIT = 10;

interface CustomerRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  tier: CustomerTier;
  marketingConsent: boolean;
  createdAt: Date;
  ordersCount: number;
  totalSpentCents: number;
}

interface CustomerOrderRow {
  id: string;
  orderNumber: string;
  createdAt: Date;
  totalCents: number;
  status: OrderStatus;
}

interface WishlistItem {
  productId: string;
  name: string;
  image?: string;
}

interface CustomerDetail {
  customer: Record<string, unknown>;
  orders: CustomerOrderRow[];
  totals: { ordersCount: number; totalSpentCents: number; averageTicketCents: number };
  wishlist: WishlistItem[];
}

interface CustomerStatsQuery {
  from?: string;
  to?: string;
}

interface TopCustomerEntry {
  customerId: string;
  name: string;
  email: string;
  tier: CustomerTier;
  totalSpentCents: number;
  ordersCount: number;
}

interface CustomerStats {
  totalCustomers: number;
  vipCount: number;
  verifiedCount: number;
  marketingConsentCount: number;
  newInRange: number;
  rangeFrom: Date;
  rangeTo: Date;
  topCustomers: TopCustomerEntry[];
}

interface RawCustomerRow {
  _id: Types.ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  tier: CustomerTier;
  marketingConsent: boolean;
  createdAt: Date;
  ordersCount: number;
  totalSpentCents: number;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reusable $lookup that annotates each customer with `ordersCount` and
 * `totalSpentCents` from their realized orders — the list and the stats
 * top-customers pipeline share it so the spend rule can never diverge.
 */
const realizedOrdersLookup = [
  {
    $lookup: {
      from: "orders",
      let: { customerId: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$customerId", "$$customerId"] },
            status: { $in: REALIZED_SALE_STATUSES },
          },
        },
        { $project: { totalCents: 1 } },
      ],
      as: "realizedOrders",
    },
  },
  {
    $addFields: {
      ordersCount: { $size: "$realizedOrders" },
      totalSpentCents: { $sum: "$realizedOrders.totalCents" },
    },
  },
];

const customerRowProjection = {
  $project: {
    name: 1,
    email: 1,
    emailVerified: 1,
    tier: 1,
    marketingConsent: 1,
    createdAt: 1,
    ordersCount: 1,
    totalSpentCents: 1,
  },
};

const toCustomerRow = (row: RawCustomerRow): CustomerRow => ({
  id: row._id.toString(),
  name: row.name,
  email: row.email,
  emailVerified: row.emailVerified,
  tier: row.tier,
  marketingConsent: row.marketingConsent,
  createdAt: row.createdAt,
  ordersCount: row.ordersCount,
  totalSpentCents: row.totalSpentCents,
});

const adminList = async (
  query: Record<string, unknown>,
): Promise<{ items: CustomerRow[]; meta: PaginationMeta }> => {
  const { page, pageSize, skip, sort } = parseListQuery(query, {
    allowedSort: ADMIN_LIST_ALLOWED_SORT,
    defaultSort: "-createdAt",
  });

  const match: Record<string, unknown> = {};
  if (
    typeof query.tier === "string" &&
    Object.values(CustomerTier).includes(query.tier as CustomerTier)
  ) {
    match.tier = query.tier;
  }
  if (query.emailVerified === "true") {
    match.emailVerified = true;
  } else if (query.emailVerified === "false") {
    match.emailVerified = false;
  }
  if (query.marketingConsent === "true") {
    match.marketingConsent = true;
  } else if (query.marketingConsent === "false") {
    match.marketingConsent = false;
  }
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    match.createdAt = {
      ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}),
      ...(to && !Number.isNaN(to.getTime()) ? { $lte: to } : {}),
    };
  }
  if (typeof query.search === "string" && query.search.trim()) {
    const regex = new RegExp(escapeRegex(query.search.trim()), "i");
    match.$or = [{ name: regex }, { email: regex }];
  }

  const [rows, total] = await Promise.all([
    Customer.aggregate<RawCustomerRow>([
      { $match: match },
      ...realizedOrdersLookup,
      customerRowProjection,
      { $sort: { ...sort, _id: 1 } },
      { $skip: skip },
      { $limit: pageSize },
    ]),
    Customer.countDocuments(match),
  ]);

  return { items: rows.map(toCustomerRow), meta: buildMeta(page, pageSize, total) };
};

const adminGetDetail = async (customerId: string): Promise<CustomerDetail> => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Cliente no encontrado.", 404);
  }

  const [orders, wishlistProducts] = await Promise.all([
    Order.find({ customerId: customer._id })
      .select("orderNumber createdAt totalCents status")
      .sort({ createdAt: -1 })
      .exec(),
    customer.wishlist.length
      ? Product.find({ _id: { $in: customer.wishlist } })
          .select("name images.cardPrimary")
          .exec()
      : Promise.resolve([]),
  ]);

  const realized = orders.filter((o) => REALIZED_SALE_STATUSES.includes(o.status));
  const totalSpentCents = realized.reduce((sum, o) => sum + o.totalCents, 0);

  return {
    customer: { ...customer.toObject({ virtuals: true }) },
    orders: orders.map((o) => ({
      id: o.id as string,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      totalCents: o.totalCents,
      status: o.status,
    })),
    totals: {
      ordersCount: realized.length,
      totalSpentCents,
      averageTicketCents:
        realized.length === 0 ? 0 : Math.round(totalSpentCents / realized.length),
    },
    wishlist: wishlistProducts.map((p) => ({
      productId: p.id as string,
      name: p.name,
      image: p.images?.cardPrimary,
    })),
  };
};

const changeTier = async (
  customerId: string,
  tier: CustomerTier,
  actor: Actor,
): Promise<{ id: string; tier: CustomerTier }> => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Cliente no encontrado.", 404);
  }
  const before = customer.tier;
  customer.tier = tier;
  await customer.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "CHANGE_CUSTOMER_TIER",
    module: MODULE,
    targetId: customer.id as string,
    before: { tier: before },
    after: { tier },
    ip: actor.ip,
  });
  return { id: customer.id as string, tier: customer.tier };
};

const STATS_DEFAULT_RANGE_DAYS = 30;

const adminStats = async (query: CustomerStatsQuery): Promise<CustomerStats> => {
  const { from, to } = parseStatsRange(query, STATS_DEFAULT_RANGE_DAYS);

  const [totalCustomers, vipCount, verifiedCount, marketingConsentCount, newInRange, topRows] =
    await Promise.all([
      Customer.countDocuments({}),
      Customer.countDocuments({ tier: CustomerTier.Vip }),
      Customer.countDocuments({ emailVerified: true }),
      Customer.countDocuments({ marketingConsent: true }),
      Customer.countDocuments({ createdAt: { $gte: from, $lt: to } }),
      Customer.aggregate<RawCustomerRow>([
        ...realizedOrdersLookup,
        { $match: { ordersCount: { $gt: 0 } } },
        customerRowProjection,
        { $sort: { totalSpentCents: -1, _id: 1 } },
        { $limit: TOP_CUSTOMERS_LIMIT },
      ]),
    ]);

  return {
    totalCustomers,
    vipCount,
    verifiedCount,
    marketingConsentCount,
    newInRange,
    rangeFrom: from,
    rangeTo: to,
    topCustomers: topRows.map((row) => ({
      customerId: row._id.toString(),
      name: row.name,
      email: row.email,
      tier: row.tier,
      totalSpentCents: row.totalSpentCents,
      ordersCount: row.ordersCount,
    })),
  };
};

export type {
  CustomerRow,
  CustomerDetail,
  CustomerStats,
  CustomerStatsQuery,
  TopCustomerEntry,
  WishlistItem,
};
export { adminList, adminGetDetail, changeTier, adminStats };
