import { UserType } from "@maria-matera/shared";
import { logger } from "../config/logger.js";
import {
  Certificate,
  type CertificateDocument,
  type CertificateSpecs,
} from "../models/Certificate.js";
import type { OrderDocument, OrderItemSnapshot } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { ProductVariant } from "../models/ProductVariant.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { generateCertificateSerial } from "../utils/serial.js";
import { recordAudit } from "./audit.service.js";
import { deleteRawAsset, uploadRawPdf } from "./media.service.js";
import { buildCertificatePdf } from "./pdf/certificate.pdf.js";

/**
 * Certificate of authenticity business logic (Milestone 8, Task 2).
 *
 * `issueForOrder` is a system-triggered, best-effort side effect of payment
 * success (wired in a later milestone as fire-and-forget) — NOT an admin
 * action, so it never calls `recordAudit` (mirrors `order.service.ts`'s
 * `applyTransition`, which also runs unaudited stock-commit logic under an
 * audited admin caller elsewhere). `adminReissue`, by contrast, IS an
 * explicit admin action reached through an authenticated admin route, so it
 * DOES audit.
 *
 * Idempotency uses check-then-create (a `findOne` per item BEFORE any
 * insert is attempted), not create-and-catch-11000, specifically to avoid
 * the dual-unique-index ambiguity documented in `Certificate.ts`'s header
 * for the common case. Only the rare race that slips past the `findOne`
 * (or a genuine 48-bit serial collision) reaches the duplicate-key handling
 * in `issueOne`, which disambiguates via `err.keyPattern` per that doc.
 */

const MODULE = "certificates";
const CERTIFICATE_FOLDER = "certificates";
// Initial attempt + exactly one retry on a genuine serialNumber collision.
const MAX_SERIAL_ATTEMPTS = 2;

interface MongoDuplicateKeyError {
  code?: number;
  keyPattern?: Record<string, unknown>;
}

const isDuplicateKeyError = (error: unknown): error is MongoDuplicateKeyError =>
  typeof error === "object" && error !== null && (error as MongoDuplicateKeyError).code === 11000;

const isSerialCollision = (error: MongoDuplicateKeyError): boolean =>
  error.keyPattern?.serialNumber !== undefined;

interface SpecsLookup {
  specs?: CertificateSpecs;
  attributes?: Record<string, string>;
}

/**
 * Best-effort specs/attributes lookup for a single order item. Never blocks
 * issuance: a missing/deleted Product/ProductVariant, or a failed lookup,
 * simply results in less (or no) specs/attributes rather than an aborted
 * certificate.
 *
 * Uses `Promise.allSettled` (not `Promise.all`) deliberately: the two
 * lookups are independent, so a genuine query failure on ONE of them (e.g.
 * `ProductVariant.findById` rejecting) must not discard a perfectly good
 * result from the OTHER — `Promise.all` would reject the whole pair and
 * throw away specs the Product-side query already had in hand.
 */
const lookupSpecsAndAttributes = async (
  item: OrderItemSnapshot,
  orderId: string,
): Promise<SpecsLookup> => {
  const [variantResult, productResult] = await Promise.allSettled([
    ProductVariant.findById(item.variantId),
    Product.findById(item.productId),
  ]);

  if (variantResult.status === "rejected") {
    logger.warn(
      { err: variantResult.reason, orderId, sku: item.sku },
      "No se pudo obtener la variante del producto para el certificado; se continúa sin sus specs.",
    );
  }
  if (productResult.status === "rejected") {
    logger.warn(
      { err: productResult.reason, orderId, sku: item.sku },
      "No se pudo obtener el producto para el certificado; se continúa sin sus specs.",
    );
  }

  const variant = variantResult.status === "fulfilled" ? variantResult.value : null;
  const product = productResult.status === "fulfilled" ? productResult.value : null;

  const material = variant?.material ?? product?.material;
  const specs: CertificateSpecs = {
    ...(material ? { material } : {}),
    ...(product?.stone?.type ? { stoneType: product.stone.type } : {}),
    ...(product?.stone?.carat !== undefined ? { stoneCarat: product.stone.carat } : {}),
    ...(variant?.size ? { size: variant.size } : {}),
  };
  const attributes = variant?.attributes ? Object.fromEntries(variant.attributes) : undefined;

  return { specs: Object.keys(specs).length > 0 ? specs : undefined, attributes };
};

/**
 * Builds, uploads, and persists ONE new certificate for `item`. Assumes the
 * caller already confirmed (via `findOne`) that no certificate exists yet for
 * this order+sku — this only handles the residual duplicate-key races/serial
 * collisions that can still occur between that check and this insert.
 *
 * Returns `undefined` (never throws for this specific, expected class of
 * failure) when the item turns out to already be issued (compound-index
 * race) or a serial collision survives its one retry — both are logged and
 * treated as "skip this item", per the model's documented 11000 ambiguity.
 * Any OTHER error (PDF build, upload, unexpected DB error) propagates to the
 * caller (`issueForOrder`), which logs it and moves on to the next item.
 */
const issueOne = async (
  order: OrderDocument,
  item: OrderItemSnapshot,
): Promise<CertificateDocument | undefined> => {
  const { specs, attributes } = await lookupSpecsAndAttributes(item, order.id as string);

  for (let attempt = 1; attempt <= MAX_SERIAL_ATTEMPTS; attempt += 1) {
    const serialNumber = generateCertificateSerial();
    const issuedAt = new Date();

    const pdfBuffer = await buildCertificatePdf({
      serialNumber,
      itemName: item.name,
      sku: item.sku,
      specs,
      issuedAt,
    });
    const { url, publicId } = await uploadRawPdf(pdfBuffer, CERTIFICATE_FOLDER);

    try {
      return await Certificate.create({
        orderId: order._id,
        customerId: order.customerId,
        orderItemSnapshot: {
          sku: item.sku,
          name: item.name,
          ...(attributes ? { attributes } : {}),
        },
        serialNumber,
        pdfUrl: url,
        publicId,
        ...(specs ? { specs } : {}),
        issuedAt,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      if (isSerialCollision(error) && attempt < MAX_SERIAL_ATTEMPTS) {
        logger.warn(
          { orderId: order.id, sku: item.sku, attempt },
          "Colisión de número de serie al emitir certificado; reintentando con un nuevo serial.",
        );
        continue;
      }
      // Either a serial collision that also failed on retry, or the compound
      // {orderId, sku} index caught a concurrent issuance that won the race
      // between our `findOne` check and this `create` — best-effort either
      // way: skip this item, never throw.
      logger.warn(
        { orderId: order.id, sku: item.sku, keyPattern: error.keyPattern },
        "No se pudo emitir el certificado por una colisión de índice único; se omite este artículo.",
      );
      return undefined;
    }
  }

  return undefined; // unreachable — loop always returns or throws
};

/**
 * Issues one certificate per order line item, skipping items already issued
 * (idempotent). Best-effort end to end: a single item's failure (PDF build,
 * upload, or DB error) is logged and the loop moves on to the next item —
 * this function NEVER throws to its caller, since it is meant to run as a
 * fire-and-forget side effect of payment success.
 */
const issueForOrder = async (order: OrderDocument): Promise<void> => {
  for (const item of order.items) {
    try {
      const existing = await Certificate.findOne({
        orderId: order._id,
        "orderItemSnapshot.sku": item.sku,
      });
      if (existing) {
        continue; // already issued — idempotent no-op, no insert attempted
      }
      await issueOne(order, item);
    } catch (error) {
      logger.error(
        { err: error, orderId: order.id, sku: item.sku },
        "No se pudo emitir el certificado para este artículo; se continúa con los demás.",
      );
    }
  }
};

// --- Owner-facing reads (always scoped by customerId IN the query) ----------

const listMine = (customerId: string): Promise<CertificateDocument[]> =>
  Certificate.find({ customerId }).sort({ issuedAt: -1 }).exec();

const getMineDownload = async (
  customerId: string,
  certId: string,
): Promise<CertificateDocument> => {
  const certificate = await Certificate.findOne({ _id: certId, customerId });
  if (!certificate) {
    // 404 (not 403) — never leak the existence of another customer's certificate.
    throw new AppError("Certificado no encontrado.", 404);
  }
  return certificate;
};

// --- Admin ---------------------------------------------------------------

const adminGetById = async (certId: string): Promise<CertificateDocument> => {
  const certificate = await Certificate.findById(certId);
  if (!certificate) {
    throw new AppError("Certificado no encontrado.", 404);
  }
  return certificate;
};

/**
 * Admin-only recovery path: rebuilds and re-uploads the SAME certificate's
 * PDF (same stored serialNumber/orderItemSnapshot/specs/issuedAt) — this is
 * a re-upload of the existing certificate's file, never a new certificate.
 * Unlike `issueForOrder`, this IS an explicit admin action, so it audits.
 */
const adminReissue = async (certId: string, actor: Actor): Promise<CertificateDocument> => {
  const certificate = await adminGetById(certId);
  const before = { pdfUrl: certificate.pdfUrl, publicId: certificate.publicId };

  const pdfBuffer = await buildCertificatePdf({
    serialNumber: certificate.serialNumber,
    itemName: certificate.orderItemSnapshot.name,
    sku: certificate.orderItemSnapshot.sku,
    specs: certificate.specs,
    issuedAt: certificate.issuedAt,
  });
  const { url, publicId } = await uploadRawPdf(pdfBuffer, CERTIFICATE_FOLDER);

  certificate.pdfUrl = url;
  certificate.publicId = publicId;
  await certificate.save();

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "REISSUE_CERTIFICATE",
    module: MODULE,
    targetId: certificate.id as string,
    before,
    after: { pdfUrl: certificate.pdfUrl, publicId: certificate.publicId },
    ip: actor.ip,
  });

  // Best-effort cleanup of the superseded Cloudinary asset, AFTER the
  // certificate has already been saved (and audited) with its new
  // pdfUrl/publicId — a cleanup failure here must never affect the reissue's
  // success or its return value (e.g. a Cloudinary hiccup, or the old asset
  // was already gone). Guarded against the (practically impossible) case
  // where the new upload happened to reuse the same publicId.
  if (before.publicId !== certificate.publicId) {
    try {
      await deleteRawAsset(before.publicId);
    } catch (error) {
      logger.warn(
        { err: error, certId: certificate.id, publicId: before.publicId },
        "No se pudo eliminar el PDF anterior del certificado en Cloudinary; queda huérfano.",
      );
    }
  }

  return certificate;
};

export { issueForOrder, listMine, getMineDownload, adminReissue };
