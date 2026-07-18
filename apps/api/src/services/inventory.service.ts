import mongoose, { type ClientSession } from "mongoose";
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
 *
 * Every self-managed transaction below (i.e. every operation invoked without a
 * caller-supplied `session`) uses `session.withTransaction(...)` rather than a
 * manual `startTransaction`/`commitTransaction`/`abortTransaction` try/catch.
 * MongoDB's own default `maxTransactionLockRequestTimeoutMillis` is a mere 5ms
 * (by design — the server fails fast on lock contention instead of queueing),
 * so any transaction can occasionally surface a `TransientTransactionError`
 * under concurrent load. `withTransaction` retries the whole callback on that
 * error class automatically; a manual commit/abort block does not, and would
 * fail outright on the first unlucky lock timeout. This matches the pattern
 * every other multi-document transaction in this codebase already uses
 * (`order.service.ts`, `coupon.service.ts`).
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

/**
 * Core reservation logic, always run against a caller-provided session. Bumps
 * each variant's `reserved` count with a conditional `findOneAndUpdate`
 * (anti-oversell) and records a `StockReservation`. Never manages the session
 * lifecycle itself — the caller owns commit/abort.
 */
const reserveWithinSession = async (
  items: ReserveItemInput[],
  orderId: string | undefined,
  session: ClientSession,
): Promise<StockReservationDocument> => {
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

  return reservation!;
};

/**
 * Reserves stock for the given items, all-or-nothing.
 *
 * Backward-compatible session extension: when `session` is provided, the
 * reservation *participates* in the caller's already-open transaction (used by
 * `orderService.createOrder`, so stock reservation, coupon redemption and order
 * creation commit/roll back together as one unit) and this function never
 * starts/commits/aborts anything — the caller owns the lifecycle. When no
 * session is given, it preserves the original self-managed single transaction
 * so every existing caller behaves exactly as before.
 */
const reserveStock = async (
  items: ReserveItemInput[],
  orderId?: string,
  session?: ClientSession,
): Promise<StockReservationDocument> => {
  if (session) {
    if (!session.inTransaction()) {
      throw new AppError(
        "reserveStock requiere una transacción activa cuando se provee una sesión.",
        500,
      );
    }
    return reserveWithinSession(items, orderId, session);
  }

  const ownSession = await mongoose.startSession();
  try {
    let reservation: StockReservationDocument | undefined;
    await ownSession.withTransaction(async () => {
      reservation = await reserveWithinSession(items, orderId, ownSession);
    });
    return reservation!;
  } finally {
    await ownSession.endSession();
  }
};

/**
 * Core commit logic, always run against a caller-provided session. Moves each
 * item from `reserved` to sold: `onHand` AND `reserved` both drop by `qty`, so
 * the units permanently leave inventory. Only acts on an `Active` reservation
 * (idempotent: a re-commit of an already-`Committed`/terminal reservation is a
 * no-op).
 */
const commitWithinSession = async (
  reservationId: string,
  session: ClientSession,
): Promise<void> => {
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
};

/**
 * Commits a reservation (reserved → sold; decrements `onHand`).
 *
 * Backward-compatible session extension (same pattern as `reserveStock` /
 * `releaseReservation`): when `session` is provided the commit participates in
 * the caller's already-open transaction (used by `orderService` when marking an
 * order paid, so committing stock and flipping the order status are atomic);
 * when omitted it preserves the original self-managed single transaction.
 */
const commitReservation = async (
  reservationId: string,
  session?: ClientSession,
): Promise<void> => {
  if (session) {
    if (!session.inTransaction()) {
      throw new AppError(
        "commitReservation requiere una transacción activa cuando se provee una sesión.",
        500,
      );
    }
    await commitWithinSession(reservationId, session);
    return;
  }

  const ownSession = await mongoose.startSession();
  try {
    await ownSession.withTransaction(async () => {
      await commitWithinSession(reservationId, ownSession);
    });
  } finally {
    await ownSession.endSession();
  }
};

/**
 * Core restock logic, always run against a caller-provided session. Re-increments
 * `onHand` for a reservation whose stock was already `Committed` (permanently
 * decremented at payment time). This is the correct inverse of a *committed*
 * reservation — distinct from `releaseReservation`, which only frees the
 * still-held `reserved` count of an `Active` reservation and would be a no-op
 * here. Moves the reservation to `Released` (terminal) so a second refund /
 * dispute event can never restock twice.
 */
const restockWithinSession = async (
  reservationId: string,
  session: ClientSession,
): Promise<void> => {
  const reservation = await StockReservation.findById(reservationId).session(session);
  if (reservation && reservation.status === ReservationStatus.Committed) {
    for (const item of reservation.items) {
      await ProductVariant.findByIdAndUpdate(
        item.variantId,
        { $inc: { onHand: item.qty } },
        { session },
      );
    }
    reservation.status = ReservationStatus.Released;
    await reservation.save({ session });
  }
};

/**
 * Restocks a previously-committed reservation (e.g. paid-then-refunded or a lost
 * dispute): puts the sold units back on hand. Same backward-compatible
 * optional-session pattern as its siblings.
 */
const restockCommitted = async (
  reservationId: string,
  session?: ClientSession,
): Promise<void> => {
  if (session) {
    if (!session.inTransaction()) {
      throw new AppError(
        "restockCommitted requiere una transacción activa cuando se provee una sesión.",
        500,
      );
    }
    await restockWithinSession(reservationId, session);
    return;
  }

  const ownSession = await mongoose.startSession();
  try {
    await ownSession.withTransaction(async () => {
      await restockWithinSession(reservationId, ownSession);
    });
  } finally {
    await ownSession.endSession();
  }
};

/** Core release logic, always run against a caller-provided session. */
const releaseWithinSession = async (
  reservationId: string,
  session: ClientSession,
): Promise<void> => {
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
};

/**
 * Releases a reservation's held stock (frees `reserved`).
 *
 * Backward-compatible session extension (same pattern as `reserveStock`): when
 * `session` is provided, the release participates in the caller's already-open
 * transaction — used by `orderService.applyTransition`, so freeing stock and
 * flipping the order's status commit/roll back atomically as one unit. When no
 * session is given, it preserves the original self-managed single transaction.
 */
const releaseReservation = async (
  reservationId: string,
  session?: ClientSession,
): Promise<void> => {
  if (session) {
    if (!session.inTransaction()) {
      throw new AppError(
        "releaseReservation requiere una transacción activa cuando se provee una sesión.",
        500,
      );
    }
    await releaseWithinSession(reservationId, session);
    return;
  }

  const ownSession = await mongoose.startSession();
  try {
    await ownSession.withTransaction(async () => {
      await releaseWithinSession(reservationId, ownSession);
    });
  } finally {
    await ownSession.endSession();
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
export {
  adjustStock,
  reserveStock,
  commitReservation,
  restockCommitted,
  releaseReservation,
  releaseExpired,
};
