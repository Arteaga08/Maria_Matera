import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { UserType } from "@maria-matera/shared";

/**
 * Certificate service (Milestone 8, Task 2). Drives real paid orders through
 * `order.service.ts` (Stripe mocked at its module boundary, same pattern as
 * `shipping.service.test.ts`) and Cloudinary mocked at the
 * `config/cloudinary.js` boundary (same pattern as `media.service.test.ts`),
 * so `certificate.service.ts`'s own logic — check-then-create idempotency,
 * best-effort specs lookup, per-item failure isolation, and the
 * audited-vs-unaudited split between `issueForOrder` and `adminReissue` — is
 * exercised end to end against a real in-memory Mongo.
 */
const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

// `orderService.markPaid` now fires `dispatchPaidSideEffects` in the
// background (Milestone 9), which itself calls the REAL `issueForOrder` —
// left un-mocked, that would race the explicit `certificateService
// .issueForOrder(order)` calls this file makes to test that function in
// isolation (both racing past the same check-then-create idempotency guard),
// producing duplicate certificates/uploads. Mocked away here; the dispatcher's
// own wiring is covered by `order.paid-dispatch.test.ts` and its internals by
// `order.notifications.test.ts`.
vi.mock("../../src/services/notification/order.notifications.js", () => ({
  dispatchPaidSideEffects: vi.fn().mockResolvedValue(undefined),
}));

const uploadStreamMock = vi.hoisted(() => vi.fn());
const destroyMock = vi.hoisted(() => vi.fn());
const isCloudinaryConfiguredMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/config/cloudinary.js", () => ({
  cloudinary: { uploader: { upload_stream: uploadStreamMock, destroy: destroyMock } },
  isCloudinaryConfigured: isCloudinaryConfiguredMock,
}));

// Overridable serial generator — undefined `impl` (the default) transparently
// falls back to the REAL `generateCertificateSerial`, so every test other
// than the two serial-collision tests below is unaffected by this mock.
const serialState = vi.hoisted(() => ({ impl: undefined as (() => string) | undefined }));
vi.mock("../../src/utils/serial.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/serial.js")>();
  return {
    generateCertificateSerial: () =>
      serialState.impl ? serialState.impl() : actual.generateCertificateSerial(),
  };
});

import { Customer } from "../../src/models/Customer.js";
import { Product, type ProductDocument } from "../../src/models/Product.js";
import { ProductVariant, type ProductVariantDocument } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import { Certificate } from "../../src/models/Certificate.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import * as orderService from "../../src/services/order.service.js";
import * as certificateService from "../../src/services/certificate.service.js";
import { AppError } from "../../src/utils/AppError.js";
import type { Actor } from "../../src/utils/actor.js";

let counter = 0;
let piSeq = 0;
let uploadSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.retrievePaymentIntent.mockReset();
  stripeMock.refund.mockReset();
  stripeMock.createPaymentIntent.mockImplementation(async () => {
    piSeq += 1;
    return { ref: `pi_mock_${piSeq}`, clientSecret: `cs_mock_${piSeq}` };
  });
  stripeMock.retrievePaymentIntent.mockImplementation(async (ref: string) => ({
    ref,
    status: "requires_payment_method",
    clientSecret: `cs_for_${ref}`,
  }));

  serialState.impl = undefined;

  uploadStreamMock.mockReset();
  isCloudinaryConfiguredMock.mockReset();
  isCloudinaryConfiguredMock.mockReturnValue(true);
  uploadSeq = 0;
  uploadStreamMock.mockImplementation((_options, callback) => {
    uploadSeq += 1;
    callback(null, {
      secure_url: `https://res.cloudinary.com/demo/raw/upload/cert-${uploadSeq}.pdf`,
      public_id: `certificates/cert-${uploadSeq}`,
    });
    return { end: vi.fn() };
  });

  destroyMock.mockReset();
  destroyMock.mockImplementation((_publicId: string, _options: unknown, callback: (error: unknown) => void) => {
    callback(null);
  });
});

const actor: Actor = { id: new mongoose.Types.ObjectId().toString(), ip: "127.0.0.1" };

const address = (overrides: Record<string, unknown> = {}) => ({
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
  ...overrides,
});

const makeCustomer = async () => {
  counter += 1;
  const customer = await Customer.create({
    name: "Cliente",
    email: `cert-svc-${counter}@test.com`,
    password: "Password123",
    addresses: [address({ label: "Envío" }), address({ label: "Facturación" })],
  });
  return {
    customer,
    customerId: customer.id as string,
    shippingAddressId: customer.addresses[0]!._id.toString(),
    billingAddressId: customer.addresses[1]!._id.toString(),
  };
};

interface ItemSpec {
  priceCents?: number;
  onHand?: number;
  qty?: number;
  material?: string;
  stoneType?: string;
  stoneCarat?: number;
  size?: string;
  attributes?: Record<string, string>;
}

const seedItems = async (
  specs: ItemSpec[],
): Promise<{ product: ProductDocument; variant: ProductVariantDocument; qty: number }[]> => {
  const seeded: { product: ProductDocument; variant: ProductVariantDocument; qty: number }[] = [];
  for (const spec of specs) {
    counter += 1;
    const hasStone = spec.stoneType !== undefined || spec.stoneCarat !== undefined;
    const product = await Product.create({
      name: `Joya Cert ${counter}`,
      slug: `joya-cert-${counter}`,
      description: "Pieza de joyería fina para prueba de certificado.",
      categoryId: new mongoose.Types.ObjectId(),
      priceCents: spec.priceCents ?? 100000,
      isPublished: true,
      isArchived: false,
      ...(spec.material ? { material: spec.material } : {}),
      ...(hasStone
        ? {
            stone: {
              ...(spec.stoneType ? { type: spec.stoneType } : {}),
              ...(spec.stoneCarat !== undefined ? { carat: spec.stoneCarat } : {}),
            },
          }
        : {}),
    });
    const variant = await ProductVariant.create({
      productId: product._id,
      sku: `CERT-${counter}`,
      onHand: spec.onHand ?? 10,
      ...(spec.size ? { size: spec.size } : {}),
      ...(spec.attributes ? { attributes: new Map(Object.entries(spec.attributes)) } : {}),
    });
    seeded.push({ product, variant, qty: spec.qty ?? 1 });
  }
  return seeded;
};

/** Seeds N products/variants, checks them out, and marks the resulting order paid. */
const seedPaidOrderForCustomer = async (
  customerId: string,
  shippingAddressId: string,
  billingAddressId: string,
  key: string,
  specs: ItemSpec[],
) => {
  const items = await seedItems(specs);
  // Upsert (not `Cart.create`): a customer placing a SECOND order in the same
  // test already has a cart document from the first checkout (left empty by
  // `orderService.createOrder`'s cart-clear step) — `Cart.create` would
  // collide with the unique `customerId` index.
  await Cart.findOneAndUpdate(
    { customerId },
    {
      $set: {
        items: items.map((s) => ({
          productId: s.product._id,
          variantId: s.variant._id,
          sku: s.variant.sku,
          qty: s.qty,
        })),
      },
    },
    { upsert: true },
  );
  const { order } = await orderService.createOrder(customerId, {
    idempotencyKey: key,
    shippingAddressId,
    billingAddressId,
  });
  const paid = await orderService.markPaid(order.id, "admin-1");
  return { order: paid, items };
};

const seedPaidOrderWithItems = async (key: string, specs: ItemSpec[]) => {
  const { customer, customerId, shippingAddressId, billingAddressId } = await makeCustomer();
  const { order, items } = await seedPaidOrderForCustomer(
    customerId,
    shippingAddressId,
    billingAddressId,
    key,
    specs,
  );
  return { order, customer, items };
};

describe("certificate.service — issueForOrder", () => {
  it("creates one certificate per item, each with a unique serial, correct sku/name snapshot, specs, and attributes", async () => {
    const { order, items } = await seedPaidOrderWithItems("key-issue-1", [
      {
        material: "Oro blanco 18k",
        stoneType: "Diamante",
        stoneCarat: 1.25,
        size: "7",
        attributes: { color: "Blanco" },
      },
      { material: "Plata .925", size: "M" },
    ]);

    await certificateService.issueForOrder(order);

    const certs = await Certificate.find({ orderId: order._id }).sort({ "orderItemSnapshot.sku": 1 });
    expect(certs).toHaveLength(2);

    const serials = certs.map((c) => c.serialNumber);
    expect(new Set(serials).size).toBe(2);
    for (const serial of serials) {
      expect(serial).toMatch(/^MM-CERT-[0-9A-F]{12}$/);
    }

    const first = certs.find((c) => c.orderItemSnapshot.sku === items[0]!.variant.sku)!;
    expect(first.orderItemSnapshot.name).toBe(items[0]!.product.name);
    expect(first.customerId.toString()).toBe(order.customerId.toString());
    expect(first.specs?.material).toBe("Oro blanco 18k");
    expect(first.specs?.stoneType).toBe("Diamante");
    expect(first.specs?.stoneCarat).toBe(1.25);
    expect(first.specs?.size).toBe("7");
    expect(first.orderItemSnapshot.attributes?.color).toBe("Blanco");

    const second = certs.find((c) => c.orderItemSnapshot.sku === items[1]!.variant.sku)!;
    expect(second.specs?.material).toBe("Plata .925");
    expect(second.specs?.size).toBe("M");
    expect(second.specs?.stoneType).toBeUndefined();
  });

  it("is idempotent — calling it twice creates no new certificates and preserves serials/pdfUrls", async () => {
    const { order } = await seedPaidOrderWithItems("key-issue-idem-1", [
      { material: "Oro" },
      { material: "Plata" },
    ]);

    await certificateService.issueForOrder(order);
    const first = await Certificate.find({ orderId: order._id }).sort({ "orderItemSnapshot.sku": 1 });
    expect(first).toHaveLength(2);

    await certificateService.issueForOrder(order);
    const second = await Certificate.find({ orderId: order._id }).sort({ "orderItemSnapshot.sku": 1 });

    expect(second).toHaveLength(2);
    expect(second.map((c) => c.serialNumber)).toEqual(first.map((c) => c.serialNumber));
    expect(second.map((c) => c.pdfUrl)).toEqual(first.map((c) => c.pdfUrl));
    // No extra Cloudinary uploads were attempted on the second (no-op) call.
    expect(uploadStreamMock).toHaveBeenCalledTimes(2);
  });

  it("continues issuing certificates for other items when one item's upload fails, and never throws", async () => {
    const { order, items } = await seedPaidOrderWithItems("key-issue-fail-1", [
      { material: "Oro" },
      { material: "Plata" },
      { material: "Platino" },
    ]);

    let call = 0;
    uploadStreamMock.mockImplementation((_options, callback) => {
      call += 1;
      if (call === 2) {
        callback(new Error("Cloudinary caído"), null);
      } else {
        callback(null, {
          secure_url: `https://res.cloudinary.com/demo/raw/upload/cert-${call}.pdf`,
          public_id: `certificates/cert-${call}`,
        });
      }
      return { end: vi.fn() };
    });

    await expect(certificateService.issueForOrder(order)).resolves.toBeUndefined();

    const certs = await Certificate.find({ orderId: order._id });
    expect(certs).toHaveLength(2);

    const failedSku = items[1]!.variant.sku;
    const issuedSkus = certs.map((c) => c.orderItemSnapshot.sku);
    expect(issuedSkus).not.toContain(failedSku);
    expect(issuedSkus).toContain(items[0]!.variant.sku);
    expect(issuedSkus).toContain(items[2]!.variant.sku);
  });

  it("still issues a certificate (without specs) when the referenced Product/ProductVariant no longer exist", async () => {
    const { order, items } = await seedPaidOrderWithItems("key-issue-missing-1", [
      { material: "Oro" },
    ]);
    await Product.deleteOne({ _id: items[0]!.product._id });
    await ProductVariant.deleteOne({ _id: items[0]!.variant._id });

    await certificateService.issueForOrder(order);

    const certs = await Certificate.find({ orderId: order._id });
    expect(certs).toHaveLength(1);
    expect(certs[0]!.orderItemSnapshot.sku).toBe(items[0]!.variant.sku);
    expect(certs[0]!.specs).toBeUndefined();
  });

  it("does not write any AuditLog entries — system-triggered side effect, not an admin action", async () => {
    const { order } = await seedPaidOrderWithItems("key-noaudit-1", [
      { material: "Oro" },
      { material: "Plata" },
    ]);

    await certificateService.issueForOrder(order);

    const entries = await AuditLog.find({});
    expect(entries).toHaveLength(0);
  });

  it("retries exactly once and succeeds when the freshly generated serial collides with an existing certificate", async () => {
    const { order } = await seedPaidOrderWithItems("key-issue-serial-retry-1", [
      { material: "Oro" },
    ]);
    // A pre-existing, unrelated certificate holding the serial the FIRST
    // generation attempt below will be forced to collide with.
    await Certificate.create({
      orderId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
      orderItemSnapshot: { sku: "UNRELATED-SKU-1", name: "Otro artículo" },
      serialNumber: "MM-CERT-COLLIDE0001",
      pdfUrl: "https://res.cloudinary.com/demo/raw/upload/pre-existing-1.pdf",
      publicId: "certificates/pre-existing-1",
    });

    let calls = 0;
    serialState.impl = () => {
      calls += 1;
      return calls === 1 ? "MM-CERT-COLLIDE0001" : `MM-CERT-RETRIED0000${calls}`;
    };

    await certificateService.issueForOrder(order);

    expect(calls).toBe(2); // exactly one retry — not zero, not more
    const certs = await Certificate.find({ orderId: order._id });
    expect(certs).toHaveLength(1);
    expect(certs[0]!.serialNumber).toBe("MM-CERT-RETRIED00002");
  });

  it("gives up on the item (without throwing) when the serial collides on both attempts, while still issuing other items' certificates", async () => {
    const { order, items } = await seedPaidOrderWithItems("key-issue-serial-retry-2", [
      { material: "Oro" },
      { material: "Plata" },
    ]);
    const failingSku = items[0]!.variant.sku;
    const okSku = items[1]!.variant.sku;

    await Certificate.create({
      orderId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
      orderItemSnapshot: { sku: "UNRELATED-SKU-2", name: "Otro artículo" },
      serialNumber: "MM-CERT-ALWAYSCOLLIDE",
      pdfUrl: "https://res.cloudinary.com/demo/raw/upload/pre-existing-2.pdf",
      publicId: "certificates/pre-existing-2",
    });

    let calls = 0;
    serialState.impl = () => {
      calls += 1;
      // Only item 1's two attempts (calls 1-2) collide; item 2's attempt
      // (call 3+) gets a distinct serial and must succeed normally.
      return calls <= 2 ? "MM-CERT-ALWAYSCOLLIDE" : `MM-CERT-OK00000000${calls}`;
    };

    await expect(certificateService.issueForOrder(order)).resolves.toBeUndefined();

    const certs = await Certificate.find({ orderId: order._id });
    expect(certs).toHaveLength(1);
    expect(certs[0]!.orderItemSnapshot.sku).toBe(okSku);
    expect(certs[0]!.orderItemSnapshot.sku).not.toBe(failingSku);
  });
});

describe("certificate.service — listMine", () => {
  it("returns only the calling customer's certificates, sorted newest first", async () => {
    // Isolation: another customer's certificate must never appear.
    const { order: otherOrder } = await seedPaidOrderWithItems("key-list-other", [
      { material: "Oro" },
    ]);
    await certificateService.issueForOrder(otherOrder);

    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { order: olderOrder } = await seedPaidOrderForCustomer(
      customerId,
      shippingAddressId,
      billingAddressId,
      "key-list-older",
      [{ material: "Plata" }],
    );
    await certificateService.issueForOrder(olderOrder);
    await Certificate.updateMany(
      { orderId: olderOrder._id },
      { $set: { issuedAt: new Date(Date.now() - 3_600_000) } },
    );

    const { order: newerOrder } = await seedPaidOrderForCustomer(
      customerId,
      shippingAddressId,
      billingAddressId,
      "key-list-newer",
      [{ material: "Platino" }],
    );
    await certificateService.issueForOrder(newerOrder);

    const mine = await certificateService.listMine(customerId);
    expect(mine).toHaveLength(2);
    expect(mine.every((c) => c.customerId.toString() === customerId)).toBe(true);
    expect(mine[0]!.orderId.toString()).toBe((newerOrder._id as mongoose.Types.ObjectId).toString());
    expect(mine[1]!.orderId.toString()).toBe((olderOrder._id as mongoose.Types.ObjectId).toString());
  });
});

describe("certificate.service — getMineDownload", () => {
  it("returns the certificate for its rightful owner", async () => {
    const { order } = await seedPaidOrderWithItems("key-get-1", [{ material: "Oro" }]);
    await certificateService.issueForOrder(order);
    const cert = (await Certificate.findOne({ orderId: order._id }))!;

    const result = await certificateService.getMineDownload(order.customerId.toString(), cert.id as string);
    expect(result.id).toBe(cert.id);
  });

  it("throws a flat 404 AppError for a certificate belonging to a different customer (never 403)", async () => {
    const { order } = await seedPaidOrderWithItems("key-get-2", [{ material: "Oro" }]);
    await certificateService.issueForOrder(order);
    const cert = (await Certificate.findOne({ orderId: order._id }))!;
    const otherCustomerId = new mongoose.Types.ObjectId().toString();

    await expect(
      certificateService.getMineDownload(otherCustomerId, cert.id as string),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws a flat 404 AppError for a nonexistent certificate id", async () => {
    const { order } = await seedPaidOrderWithItems("key-get-3", [{ material: "Oro" }]);

    await expect(
      certificateService.getMineDownload(
        order.customerId.toString(),
        new mongoose.Types.ObjectId().toString(),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("certificate.service — adminReissue", () => {
  it("regenerates pdfUrl/publicId, keeps the same serialNumber, and audits REISSUE_CERTIFICATE", async () => {
    const { order } = await seedPaidOrderWithItems("key-reissue-1", [{ material: "Oro" }]);
    await certificateService.issueForOrder(order);
    const original = (await Certificate.findOne({ orderId: order._id }))!;
    const originalSerial = original.serialNumber;
    const originalUrl = original.pdfUrl;
    const originalPublicId = original.publicId;

    uploadStreamMock.mockImplementationOnce((_options, callback) => {
      callback(null, {
        secure_url: "https://res.cloudinary.com/demo/raw/upload/cert-REISSUED.pdf",
        public_id: "certificates/cert-REISSUED",
      });
      return { end: vi.fn() };
    });

    const reissued = await certificateService.adminReissue(original.id as string, actor);

    expect(reissued.serialNumber).toBe(originalSerial);
    expect(reissued.pdfUrl).toBe("https://res.cloudinary.com/demo/raw/upload/cert-REISSUED.pdf");
    expect(reissued.publicId).toBe("certificates/cert-REISSUED");
    expect(reissued.pdfUrl).not.toBe(originalUrl);
    expect(reissued.publicId).not.toBe(originalPublicId);

    const reloaded = await Certificate.findById(original.id as string);
    expect(reloaded!.pdfUrl).toBe(reissued.pdfUrl);
    expect(reloaded!.serialNumber).toBe(originalSerial);

    const audit = await AuditLog.findOne({
      action: "REISSUE_CERTIFICATE",
      targetId: original.id as string,
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorType).toBe(UserType.Admin);
    expect(audit!.module).toBe("certificates");
    expect((audit!.before as { pdfUrl?: string }).pdfUrl).toBe(originalUrl);
    expect((audit!.after as { pdfUrl?: string }).pdfUrl).toBe(reissued.pdfUrl);
  });

  it("deletes the superseded Cloudinary asset (deleteRawAsset) with the OLD publicId after a successful reissue", async () => {
    const { order } = await seedPaidOrderWithItems("key-reissue-cleanup-1", [{ material: "Oro" }]);
    await certificateService.issueForOrder(order);
    const original = (await Certificate.findOne({ orderId: order._id }))!;
    const originalPublicId = original.publicId;

    uploadStreamMock.mockImplementationOnce((_options, callback) => {
      callback(null, {
        secure_url: "https://res.cloudinary.com/demo/raw/upload/cert-CLEANUP.pdf",
        public_id: "certificates/cert-CLEANUP",
      });
      return { end: vi.fn() };
    });

    await certificateService.adminReissue(original.id as string, actor);

    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledWith(
      originalPublicId,
      { resource_type: "raw" },
      expect.any(Function),
    );
  });

  it("still succeeds and returns the updated certificate even when deleting the old asset fails (best-effort cleanup)", async () => {
    const { order } = await seedPaidOrderWithItems("key-reissue-cleanup-2", [{ material: "Oro" }]);
    await certificateService.issueForOrder(order);
    const original = (await Certificate.findOne({ orderId: order._id }))!;

    uploadStreamMock.mockImplementationOnce((_options, callback) => {
      callback(null, {
        secure_url: "https://res.cloudinary.com/demo/raw/upload/cert-CLEANUP-FAIL.pdf",
        public_id: "certificates/cert-CLEANUP-FAIL",
      });
      return { end: vi.fn() };
    });
    destroyMock.mockImplementationOnce(
      (_publicId: string, _options: unknown, callback: (error: unknown) => void) => {
        callback(new Error("Cloudinary destroy caído"));
      },
    );

    const reissued = await certificateService.adminReissue(original.id as string, actor);

    expect(reissued.pdfUrl).toBe("https://res.cloudinary.com/demo/raw/upload/cert-CLEANUP-FAIL.pdf");
    expect(reissued.publicId).toBe("certificates/cert-CLEANUP-FAIL");

    const reloaded = await Certificate.findById(original.id as string);
    expect(reloaded!.pdfUrl).toBe(reissued.pdfUrl);
    expect(reloaded!.publicId).toBe(reissued.publicId);

    // The reissue itself is still recorded in the audit trail despite the
    // cleanup failure.
    const audit = await AuditLog.findOne({
      action: "REISSUE_CERTIFICATE",
      targetId: original.id as string,
    });
    expect(audit).not.toBeNull();
  });

  it("throws a flat 404 AppError for a nonexistent certificate", async () => {
    await expect(
      certificateService.adminReissue(new mongoose.Types.ObjectId().toString(), actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
