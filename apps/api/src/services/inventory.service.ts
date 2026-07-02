import mongoose from "mongoose";
import { ReservationStatus, UserType } from "@maria-matera/shared";
import { ProductVariant, type ProductVariantDocument } from "../models/ProductVariant.js";
import { StockReservation, type StockReservationDocument } from "../models/StockReservation.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { recordAudit } from "./audit.service.js";
import { notifyOwner } from "./notification/telegram.js";

/**
 * Inventory operations. Stock reservation is the anti-oversell mechanism:
 * a reservation atomically bumps each variant's `reserved` count only if enough
 * is available (`onHand − reserved ≥ qty`), inside a transaction so a multi-item
 * hold is all-or-nothing. Commit moves reserved → sold (decrements onHand);
 * release frees it.
 */

const MODULE = "Inventario";
const RESERVATION_TTL_MS = 15 * 60 * 1000; // 15 min
const LOW_STOCK_THRESHOLD = 5;

interface ReserveItemInput {
  variantId: string;
  qty: number;
}

const adjustStock = async (
  variantId: string,
  onHand: number,
  actor: Actor,
): Promise<ProductVariantDocument> => {
  const variant = await ProductVariant.findById(variantId);
  if (!variant) {
    throw new AppError("Variante no encontrada", 404);
  }
  const before = variant.onHand;
  variant.onHand = onHand;
  await variant.save();
  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "ADJUST_STOCK",
    module: MODULE,
    targetId: variant.id as string,
    before: { onHand: before },
    after: { onHand },
    ip: actor.ip,
  });

  // Fire-and-forget low-stock alert (never blocks the adjustment).
  if (variant.onHand <= LOW_STOCK_THRESHOLD) {
    void notifyOwner(
      `⚠️ Stock bajo: SKU \`${variant.sku}\` (${variant.onHand} disponibles).`,
    );
  }
  return variant;
};

const reserveStock = async (
  items: ReserveItemInput[],
  orderId?: string,
): Promise<StockReservationDocument> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    for (const item of items) {
      const updated = await ProductVariant.findOneAndUpdate(
        {
          _id: item.variantId,
          isArchived: false,
          $expr: { $gte: [{ $subtract: ["$onHand", "$reserved"] }, item.qty] },
        },
        { $inc: { reserved: item.qty } },
        { session, new: true },
      );
      if (!updated) {
        throw new AppError("Stock insuficiente para uno o más artículos.", 409);
      }
    }

    const [reservation] = await StockReservation.create(
      [
        {
          orderId,
          items: items.map((item) => ({ variantId: item.variantId, qty: item.qty })),
          status: ReservationStatus.Active,
          expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        },
      ],
      { session },
    );

    await session.commitTransaction();
    return reservation!;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

const commitReservation = async (reservationId: string): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const reservation = await StockReservation.findById(reservationId).session(session);
    if (!reservation) {
      throw new AppError("Reserva no encontrada", 404);
    }
    if (reservation.status === ReservationStatus.Active) {
      for (const item of reservation.items) {
        await ProductVariant.findByIdAndUpdate(
          item.variantId,
          { $inc: { onHand: -item.qty, reserved: -item.qty } },
          { session },
        );
      }
      reservation.status = ReservationStatus.Committed;
      await reservation.save({ session });
    }
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

const releaseReservation = async (reservationId: string): Promise<void> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const reservation = await StockReservation.findById(reservationId).session(session);
    if (reservation && reservation.status === ReservationStatus.Active) {
      for (const item of reservation.items) {
        await ProductVariant.findByIdAndUpdate(
          item.variantId,
          { $inc: { reserved: -item.qty } },
          { session },
        );
      }
      reservation.status = ReservationStatus.Released;
      await reservation.save({ session });
    }
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

const releaseExpired = async (): Promise<number> => {
  const expired = await StockReservation.find({
    status: ReservationStatus.Active,
    expiresAt: { $lt: new Date() },
  }).select("_id");
  for (const reservation of expired) {
    await releaseReservation(reservation.id as string);
  }
  return expired.length;
};

export type { ReserveItemInput };
export { adjustStock, reserveStock, commitReservation, releaseReservation, releaseExpired };
