import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { ReservationStatus } from "@maria-matera/shared";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import * as inventory from "../../src/services/inventory.service.js";

/**
 * Inventory service (sub-step 2b): atomic stock reservation (anti-oversell),
 * commit, release, and expiry sweeping — exercised against a replica set so
 * transactions run.
 */

const makeVariant = (onHand: number) =>
  ProductVariant.create({
    productId: new mongoose.Types.ObjectId(),
    sku: `TEST-${Math.random().toString(36).slice(2, 8)}`,
    onHand,
  });

describe("Inventory 2b", () => {
  it("reserves stock and commits it (onHand decremented)", async () => {
    const variant = await makeVariant(5);
    const reservation = await inventory.reserveStock([{ variantId: variant.id, qty: 2 }]);

    const afterReserve = await ProductVariant.findById(variant.id);
    expect(afterReserve!.reserved).toBe(2);
    expect(afterReserve!.available).toBe(3);

    await inventory.commitReservation(reservation.id as string);

    const afterCommit = await ProductVariant.findById(variant.id);
    expect(afterCommit!.onHand).toBe(3);
    expect(afterCommit!.reserved).toBe(0);
  });

  it("rejects a reservation that exceeds availability (no oversell)", async () => {
    const variant = await makeVariant(1);
    await expect(inventory.reserveStock([{ variantId: variant.id, qty: 2 }])).rejects.toThrow();

    const after = await ProductVariant.findById(variant.id);
    expect(after!.reserved).toBe(0);
  });

  it("releases a reservation and frees the reserved stock", async () => {
    const variant = await makeVariant(4);
    const reservation = await inventory.reserveStock([{ variantId: variant.id, qty: 3 }]);

    await inventory.releaseReservation(reservation.id as string);

    const after = await ProductVariant.findById(variant.id);
    expect(after!.reserved).toBe(0);
    expect(after!.onHand).toBe(4);
  });

  it("never oversells under concurrent reservations", async () => {
    const variant = await makeVariant(1);

    const results = await Promise.allSettled([
      inventory.reserveStock([{ variantId: variant.id, qty: 1 }]),
      inventory.reserveStock([{ variantId: variant.id, qty: 1 }]),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const after = await ProductVariant.findById(variant.id);
    expect(after!.reserved).toBe(1);
  });

  it("releases expired reservations via the sweeper", async () => {
    const variant = await makeVariant(2);
    const reservation = await inventory.reserveStock([{ variantId: variant.id, qty: 2 }]);
    await StockReservation.updateOne(
      { _id: reservation.id },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const released = await inventory.releaseExpired();
    expect(released).toBe(1);

    const after = await ProductVariant.findById(variant.id);
    expect(after!.reserved).toBe(0);
    const reloaded = await StockReservation.findById(reservation.id);
    expect(reloaded!.status).toBe(ReservationStatus.Released);
  });
});
