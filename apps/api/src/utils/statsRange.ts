import { AppError } from "./AppError.js";

/**
 * Shared date-range parser for admin stats endpoints. Extracted from the
 * near-identical private copies in `order.service.ts` and
 * `customer.admin.service.ts` — they only differed in the default window
 * (7 vs 30 days), so that is now a parameter and each consumer keeps its
 * original behavior.
 */

interface StatsRangeQuery {
  from?: string;
  to?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const parseStatsRange = (
  query: StatsRangeQuery,
  defaultRangeDays: number,
): { from: Date; to: Date } => {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultRangeDays * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new AppError("El rango de fechas no es válido.", 400);
  }
  return { from, to };
};

export type { StatsRangeQuery };
export { parseStatsRange };
