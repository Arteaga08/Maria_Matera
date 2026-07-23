import { describe, expect, it } from "vitest";
import { parseStatsRange } from "../../src/utils/statsRange.js";
import { AppError } from "../../src/utils/AppError.js";

/**
 * Shared stats date-range parser. Extracted from the identical-but-for-the-
 * default copies in `order.service.ts` (7 days) and
 * `customer.admin.service.ts` (30 days) — the default window is now a
 * parameter so behavior stays byte-identical for both consumers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describe("parseStatsRange", () => {
  it("defaults `to` to now and `from` to `to - defaultRangeDays`", () => {
    const before = Date.now();
    const { from, to } = parseStatsRange({}, 7);
    const after = Date.now();

    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime()).toBeLessThanOrEqual(after);
    expect(to.getTime() - from.getTime()).toBe(7 * DAY_MS);

    const monthly = parseStatsRange({}, 30);
    expect(monthly.to.getTime() - monthly.from.getTime()).toBe(30 * DAY_MS);
  });

  it("honors an explicit valid range", () => {
    const { from, to } = parseStatsRange({ from: "2026-07-01", to: "2026-07-15" }, 7);

    expect(from).toEqual(new Date("2026-07-01"));
    expect(to).toEqual(new Date("2026-07-15"));
  });

  it("applies the default window backwards from an explicit `to`", () => {
    const { from, to } = parseStatsRange({ to: "2026-07-15" }, 30);

    expect(to).toEqual(new Date("2026-07-15"));
    expect(to.getTime() - from.getTime()).toBe(30 * DAY_MS);
  });

  it("throws a 400 AppError when from > to or dates are unparseable", () => {
    const inverted = () => parseStatsRange({ from: "2026-07-15", to: "2026-07-01" }, 7);
    const garbageFrom = () => parseStatsRange({ from: "not-a-date" }, 7);
    const garbageTo = () => parseStatsRange({ to: "not-a-date" }, 7);

    for (const call of [inverted, garbageFrom, garbageTo]) {
      expect(call).toThrow(AppError);
      expect(call).toThrow("El rango de fechas no es válido.");
      try {
        call();
      } catch (error) {
        expect((error as AppError).statusCode).toBe(400);
      }
    }
  });
});
