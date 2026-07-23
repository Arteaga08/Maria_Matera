import * as orderService from "./order.service.js";
import * as inventoryService from "./inventory.service.js";
import * as customerAdminService from "./customer.admin.service.js";
import * as subscriberService from "./subscriber.service.js";
import * as desireService from "./desire.service.js";
import { parseStatsRange, type StatsRangeQuery } from "../utils/statsRange.js";

/**
 * Dashboard home/overview. PURE composition: the date window is resolved once
 * here (30-day default) and passed explicitly — as ISO strings, which the
 * per-subsystem stats accept verbatim — so every section shares the SAME
 * window. Note this means orders runs on 30 days inside the overview while
 * `/admin/orders/stats` keeps its own 7-day default: intentional, one window
 * per screen beats per-section defaults.
 *
 * No business logic lives here; the only local decisions are payload trims
 * (top-5 slices) — the full lists live on each subsystem's own endpoint.
 */

const STATS_DEFAULT_RANGE_DAYS = 30;
const TOP_ITEMS_LIMIT = 5;

interface OverviewStats {
  rangeFrom: Date;
  rangeTo: Date;
  orders: orderService.OrderStats;
  inventory: inventoryService.InventoryStats;
  customers: customerAdminService.CustomerStats;
  marketing: subscriberService.SubscriberStats;
  desire: { products: desireService.DesireRow[] };
}

const adminOverview = async (query: StatsRangeQuery): Promise<OverviewStats> => {
  const { from, to } = parseStatsRange(query, STATS_DEFAULT_RANGE_DAYS);
  const range = { from: from.toISOString(), to: to.toISOString() };

  const [orders, inventory, customers, marketing, desire] = await Promise.all([
    orderService.adminStats(range),
    inventoryService.adminStats(),
    customerAdminService.adminStats(range),
    subscriberService.adminStats(range),
    desireService.adminDesire(range),
  ]);

  return {
    rangeFrom: from,
    rangeTo: to,
    orders: { ...orders, topProducts: orders.topProducts.slice(0, TOP_ITEMS_LIMIT) },
    inventory,
    customers,
    marketing,
    desire: { products: desire.products.slice(0, TOP_ITEMS_LIMIT) },
  };
};

export type { OverviewStats };
export { adminOverview };
