import { describe, expect, it } from "vitest";
import { generateOrderNumber } from "../../src/utils/orderNumber.js";

describe("generateOrderNumber", () => {
  it("matches the MM-<12 hex chars> format", () => {
    expect(generateOrderNumber()).toMatch(/^MM-[0-9A-F]{12}$/);
  });

  it("produces effectively unique values across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(generateOrderNumber());
    }
    expect(seen.size).toBe(10_000);
  });
});
