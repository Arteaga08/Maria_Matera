import PDFDocument from "pdfkit";

/**
 * Pure PDF renderer for a certificate of authenticity — no DB access, no
 * network calls, no Cloudinary. Renders into an in-memory Buffer via
 * pdfkit's streaming API (`'data'`/`'end'` events collected into chunks).
 *
 * Content is deliberately minimal: brand, serial, item, specs, issue date —
 * nothing else. No customer name or other PII belongs on this document.
 *
 * The optional `compress` flag (default `true`, i.e. normal production PDFs)
 * exists so tests can render with `compress: false` and assert on the raw
 * text bytes directly — the real production artifact isn't shaped around
 * that test convenience.
 */

interface CertificatePdfSpecs {
  material?: string;
  stoneType?: string;
  stoneCarat?: number;
  size?: string;
}

interface CertificatePdfData {
  serialNumber: string;
  itemName: string;
  sku: string;
  specs?: CertificatePdfSpecs;
  issuedAt: Date;
}

const buildSpecLines = (specs: CertificatePdfSpecs | undefined): string[] => {
  if (!specs) return [];
  const lines: string[] = [];
  if (specs.material !== undefined) lines.push(`Material: ${specs.material}`);
  if (specs.stoneType !== undefined) lines.push(`Tipo de piedra: ${specs.stoneType}`);
  if (specs.stoneCarat !== undefined) lines.push(`Quilates: ${specs.stoneCarat}`);
  if (specs.size !== undefined) lines.push(`Talla: ${specs.size}`);
  return lines;
};

const buildCertificatePdf = (data: CertificatePdfData, compress = true): Promise<Buffer> => {
  const doc = new PDFDocument({ size: "A4", margin: 72, compress });
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (error: Error) => reject(error));

    doc.font("Helvetica-Bold").fontSize(28).text("Maria Matera", { align: "center" });
    doc.moveDown(0.5);
    doc
      .font("Helvetica")
      .fontSize(16)
      .text("Certificado de Autenticidad", { align: "center" });

    doc.moveDown(2);
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .text(`Serial: ${data.serialNumber}`, { align: "center" });

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(12).text("Artículo");
    doc.font("Helvetica").fontSize(12).text(data.itemName);
    doc.font("Helvetica").fontSize(10).text(`SKU: ${data.sku}`);

    const specLines = buildSpecLines(data.specs);
    if (specLines.length > 0) {
      doc.moveDown(1);
      doc.font("Helvetica-Bold").fontSize(12).text("Especificaciones");
      doc.font("Helvetica").fontSize(11);
      for (const line of specLines) {
        doc.text(line);
      }
    }

    doc.moveDown(2);
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(`Fecha de emisión: ${data.issuedAt.toLocaleDateString("es-MX")}`);

    doc.end();
  });
};

export type { CertificatePdfData };
export { buildCertificatePdf };
