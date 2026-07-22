import mongoose, { Types, type ClientSession, type PipelineStage } from "mongoose";
import { ReservationStatus, UserType } from "@maria-matera/shared";
import type { PaginationMeta } from "@maria-matera/shared";
import { Category } from "../models/Category.js";
import { ProductVariant, type ProductVariantDocument } from "../models/ProductVariant.js";
import { StockReservation, type StockReservationDocument } from "../models/StockReservation.js";
import { AppError } from "../utils/AppError.js";
import type { Actor } from "../utils/actor.js";
import { parseListQuery, buildMeta } from "../utils/listQuery.js";
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

// --- Admin operational view (Bloque 2 dashboard) -----------------------------

const ADMIN_LIST_ALLOWED_SORT = ["available", "sku", "onHand"];

interface InventoryRow {
  variantId: string;
  sku: string;
  size?: string;
  material?: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStock: boolean;
  isArchived: boolean;
  productId: string;
  productName: string;
  productImage?: string;
}

interface InventoryStats {
  totalVariants: number;
  totalOnHand: number;
  totalReserved: number;
  lowStock: { count: number; skus: string[] };
  outOfStock: { count: number; skus: string[] };
  activeReservations: { count: number; units: number };
}

interface RawInventoryRow {
  _id: Types.ObjectId;
  sku: string;
  size?: string;
  material?: string;
  onHand: number;
  reserved: number;
  available: number;
  isArchived: boolean;
  product: { _id: Types.ObjectId; name: string; images?: { cardPrimary?: string } };
}

/**
 * Per-variant operational stock list. Aggregation (not a plain find) because
 * `available` is a Mongoose virtual — invisible to queries — so it is
 * recomputed server-side with `$subtract` to allow filtering/sorting on it.
 */
const adminList = async (
  query: Record<string, unknown>,
): Promise<{ items: InventoryRow[]; meta: PaginationMeta }> => {
  const { page, pageSize, skip, sort } = parseListQuery(query, {
    allowedSort: ADMIN_LIST_ALLOWED_SORT,
    defaultSort: "available",
  });

  const variantMatch: Record<string, unknown> = {};
  if (query.includeArchived !== "true") {
    variantMatch.isArchived = false;
  }

  const postLookupMatch: Record<string, unknown> = {};
  if (query.lowStock === "true") {
    postLookupMatch.available = { $lte: LOW_STOCK_THRESHOLD };
  }
  if (query.outOfStock === "true") {
    postLookupMatch.available = { $lte: 0 };
  }
  if (typeof query.category === "string" && query.category.trim()) {
    const category = await Category.findOne({ slug: query.category.trim() });
    postLookupMatch["product.categoryId"] = category?._id ?? new Types.ObjectId();
  }
  if (typeof query.search === "string" && query.search.trim()) {
    const regex = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    postLookupMatch.$or = [{ sku: regex }, { "product.name": regex }];
  }

  const basePipeline: PipelineStage[] = [
    { $match: variantMatch },
    { $addFields: { available: { $subtract: ["$onHand", "$reserved"] } } },
    {
      $lookup: {
        from: "products",
        localField: "productId",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: "$product" },
    ...(Object.keys(postLookupMatch).length ? [{ $match: postLookupMatch }] : []),
  ];

  const [rows, countRows] = await Promise.all([
    ProductVariant.aggregate<RawInventoryRow>([
      ...basePipeline,
      { $sort: { ...sort, _id: 1 } },
      { $skip: skip },
      { $limit: pageSize },
      {
        $project: {
          sku: 1,
          size: 1,
          material: 1,
          onHand: 1,
          reserved: 1,
          available: 1,
          isArchived: 1,
          "product._id": 1,
          "product.name": 1,
          "product.images.cardPrimary": 1,
        },
      },
    ]),
    ProductVariant.aggregate<{ total: number }>([...basePipeline, { $count: "total" }]),
  ]);

  const items: InventoryRow[] = rows.map((row) => ({
    variantId: row._id.toString(),
    sku: row.sku,
    size: row.size,
    material: row.material,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.available,
    lowStock: row.available <= LOW_STOCK_THRESHOLD,
    isArchived: row.isArchived,
    productId: row.product._id.toString(),
    productName: row.product.name,
    productImage: row.product.images?.cardPrimary,
  }));

  return { items, meta: buildMeta(page, pageSize, countRows[0]?.total ?? 0) };
};

/** Aggregate stock health snapshot for the dashboard. Archived variants excluded. */
const adminStats = async (): Promise<InventoryStats> => {
  const [variantAgg, alertRows, reservationAgg] = await Promise.all([
    ProductVariant.aggregate<{ totalVariants: number; totalOnHand: number; totalReserved: number }>([
      { $match: { isArchived: false } },
      {
        $group: {
          _id: null,
          totalVariants: { $sum: 1 },
          totalOnHand: { $sum: "$onHand" },
          totalReserved: { $sum: "$reserved" },
        },
      },
    ]),
    ProductVariant.aggregate<{ sku: string; available: number }>([
      { $match: { isArchived: false } },
      { $addFields: { available: { $subtract: ["$onHand", "$reserved"] } } },
      { $match: { available: { $lte: LOW_STOCK_THRESHOLD } } },
      { $sort: { available: 1, sku: 1 } },
      { $project: { sku: 1, available: 1 } },
    ]),
    StockReservation.aggregate<{ count: number; units: number }>([
      { $match: { status: ReservationStatus.Active } },
      { $unwind: "$items" },
      { $group: { _id: "$_id", units: { $sum: "$items.qty" } } },
      { $group: { _id: null, count: { $sum: 1 }, units: { $sum: "$units" } } },
    ]),
  ]);

  const totals = variantAgg[0] ?? { totalVariants: 0, totalOnHand: 0, totalReserved: 0 };
  const outRows = alertRows.filter((r) => r.available <= 0);

  return {
    totalVariants: totals.totalVariants,
    totalOnHand: totals.totalOnHand,
    totalReserved: totals.totalReserved,
    lowStock: { count: alertRows.length, skus: alertRows.map((r) => r.sku) },
    outOfStock: { count: outRows.length, skus: outRows.map((r) => r.sku) },
    activeReservations: {
      count: reservationAgg[0]?.count ?? 0,
      units: reservationAgg[0]?.units ?? 0,
    },
  };
};

export type { ReserveItemInput, InventoryRow, InventoryStats };
export {
  LOW_STOCK_THRESHOLD,
  adjustStock,
  reserveStock,
  commitReservation,
  restockCommitted,
  releaseReservation,
  releaseExpired,
  adminList,
  adminStats,
};
