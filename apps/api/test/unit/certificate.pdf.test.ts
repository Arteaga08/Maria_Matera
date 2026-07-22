import { describe, expect, it } from "vitest";
import { buildCertificatePdf } from "../../src/services/pdf/certificate.pdf.js";

// `compress: false` (second arg) is a test-only affordance so the raw PDF
// bytes are directly inspectable — production callers use the default
// `compress: true`.
//
// Note: pdfkit encodes text content as hex glyph runs split across multiple
// `TJ` array chunks wherever the font's kerning table has an adjustment for
// an adjacent letter pair (confirmed by inspecting the raw uncompressed
// stream — e.g. "MM-CERT-A1B2C3D4E5F6" is fragmented into several separate
// hex runs). That rules out a reliable `.toContain(serialNumber)`-style
// assertion without disabling kerning, so these tests stick to structural
// checks (valid PDF, no throw, no literal "undefined").

describe("buildCertificatePdf", () => {
  it("returns a Buffer starting with the PDF magic header", async () => {
    const pdf = await buildCertificatePdf(
      {
        serialNumber: "MM-CERT-A1B2C3D4E5F6",
        itemName: "Anillo Solitario",
        sku: "RING-001",
        specs: {
          material: "Oro blanco 18k",
          stoneType: "Diamante",
          stoneCarat: 1.25,
          size: "7",
        },
        issuedAt: new Date("2026-07-21T00:00:00Z"),
      },
      false,
    );

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders full specs without throwing and without literal 'undefined' text", async () => {
    const pdf = await buildCertificatePdf(
      {
        serialNumber: "MM-CERT-A1B2C3D4E5F6",
        itemName: "Anillo Solitario",
        sku: "RING-001",
        specs: {
          material: "Oro blanco 18k",
          stoneType: "Diamante",
          stoneCarat: 1.25,
          size: "7",
        },
        issuedAt: new Date("2026-07-21T00:00:00Z"),
      },
      false,
    );

    expect(pdf.toString("latin1")).not.toContain("undefined");
  });

  it("renders with no specs at all without throwing and without literal 'undefined' text", async () => {
    const pdf = await buildCertificatePdf(
      {
        serialNumber: "MM-CERT-DEADBEEFCAFE",
        itemName: "Pulsera Clásica",
        sku: "BRACE-002",
        issuedAt: new Date("2026-07-21T00:00:00Z"),
      },
      false,
    );

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("utf-8")).toBe("%PDF");
    expect(pdf.toString("latin1")).not.toContain("undefined");
  });

  it("renders with a specs object whose fields are all undefined without throwing or printing 'undefined'", async () => {
    const pdf = await buildCertificatePdf(
      {
        serialNumber: "MM-CERT-FEEDFACE1234",
        itemName: "Collar Elegante",
        sku: "NECK-003",
        specs: {
          material: undefined,
          stoneType: undefined,
          stoneCarat: undefined,
          size: undefined,
        },
        issuedAt: new Date("2026-07-21T00:00:00Z"),
      },
      false,
    );

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString("latin1")).not.toContain("undefined");
  });

  it("defaults to compress: true when the second argument is omitted (production shape)", async () => {
    const pdf = await buildCertificatePdf({
      serialNumber: "MM-CERT-A1B2C3D4E5F6",
      itemName: "Anillo Solitario",
      sku: "RING-001",
      issuedAt: new Date("2026-07-21T00:00:00Z"),
    });

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("utf-8")).toBe("%PDF");
  });
});
