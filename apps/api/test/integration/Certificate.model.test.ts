import { beforeAll, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Certificate } from "../../src/models/Certificate.js";

/**
 * Model-only test (no service layer involved yet — that's Milestone 8 Task 2).
 * Proves the two uniqueness guarantees Task 2's idempotency logic will rely
 * on: a compound unique index on {orderId, orderItemSnapshot.sku} (one
 * certificate per order line item) and a unique serialNumber.
 *
 * `Certificate.init()` waits for index creation to finish — `Model.create()`
 * does not implicitly wait for background index builds, so without this the
 * duplicate-key assertions below would race the index build and flake.
 */

beforeAll(async () => {
  await Certificate.init();
});

const baseDoc = () => ({
  orderId: new Types.ObjectId(),
  customerId: new Types.ObjectId(),
  orderItemSnapshot: { sku: "RING-001", name: "Anillo Solitario" },
  pdfUrl: "https://res.cloudinary.com/demo/raw/upload/cert.pdf",
  publicId: "certificates/cert123",
});

describe("Certificate model", () => {
  it("rejects a second certificate for the same order+sku (compound unique index)", async () => {
    const orderId = new Types.ObjectId();

    await Certificate.create({
      ...baseDoc(),
      orderId,
      serialNumber: "MM-CERT-AAAAAAAA",
    });

    await expect(
      Certificate.create({
        ...baseDoc(),
        orderId,
        serialNumber: "MM-CERT-BBBBBBBB",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same sku across two different orders", async () => {
    await Certificate.create({
      ...baseDoc(),
      orderId: new Types.ObjectId(),
      serialNumber: "MM-CERT-CCCCCCCC",
    });

    await expect(
      Certificate.create({
        ...baseDoc(),
        orderId: new Types.ObjectId(),
        serialNumber: "MM-CERT-DDDDDDDD",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a duplicate serialNumber even across different orders/skus", async () => {
    await Certificate.create({
      ...baseDoc(),
      orderId: new Types.ObjectId(),
      orderItemSnapshot: { sku: "RING-001", name: "Anillo Solitario" },
      serialNumber: "MM-CERT-EEEEEEEE",
    });

    await expect(
      Certificate.create({
        ...baseDoc(),
        orderId: new Types.ObjectId(),
        orderItemSnapshot: { sku: "BRACE-002", name: "Pulsera Clásica" },
        serialNumber: "MM-CERT-EEEEEEEE",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("defaults issuedAt to now and persists specs/attributes", async () => {
    const before = Date.now();
    const cert = await Certificate.create({
      ...baseDoc(),
      serialNumber: "MM-CERT-FFFFFFFF",
      orderItemSnapshot: {
        sku: "RING-001",
        name: "Anillo Solitario",
        attributes: { color: "Blanco" },
      },
      specs: { material: "Oro blanco 18k", stoneType: "Diamante", stoneCarat: 1.25, size: "7" },
    });

    expect(cert.issuedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(cert.specs?.material).toBe("Oro blanco 18k");
    expect(cert.orderItemSnapshot.attributes?.color).toBe("Blanco");
  });
});
