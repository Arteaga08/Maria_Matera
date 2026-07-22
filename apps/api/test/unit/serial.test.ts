import { describe, expect, it } from "vitest";
import { generateCertificateSerial } from "../../src/utils/serial.js";

describe("generateCertificateSerial", () => {
  it("matches the MM-CERT-<12 hex chars> format", () => {
    expect(generateCertificateSerial()).toMatch(/^MM-CERT-[0-9A-F]{12}$/);
  });

  it("produces effectively unique values across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(generateCertificateSerial());
    }
    expect(seen.size).toBe(10_000);
  });
});
