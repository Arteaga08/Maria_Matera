import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { ReservationStatus } from "@maria-matera/shared";

/**
 * A short-lived hold on stock created at checkout. While `active`, each item's
 * `qty` is added to the variant's `reserved` count. On payment success it is
 * committed (onHand decremented); on failure/expiry it is released.
 *
 * Note: no destructive TTL index — auto-deleting an active reservation would
 * strand `reserved` stock. Expired holds are released by a sweeper
 * (`releaseExpired`) run on a schedule; the `{status, expiresAt}` index backs it.
 */

interface ReservationItem {
  variantId: Types.ObjectId;
  qty: number;
}

interface StockReservationDocument extends Document {
  orderId?: Types.ObjectId;
  items: ReservationItem[];
  status: ReservationStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const reservationItemSchema = new Schema<ReservationItem>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const stockReservationSchema = new Schema<StockReservationDocument>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", index: true },
    items: { type: [reservationItemSchema], required: true },
    status: {
      type: String,
      enum: Object.values(ReservationStatus),
      default: ReservationStatus.Active,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

stockReservationSchema.index({ status: 1, expiresAt: 1 });

const StockReservation: Model<StockReservationDocument> =
  (models.StockReservation as Model<StockReservationDocument>) ??
  model<StockReservationDocument>("StockReservation", stockReservationSchema);

export type { StockReservationDocument, ReservationItem };
export { StockReservation };
