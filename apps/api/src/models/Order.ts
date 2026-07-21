import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import {
  Carrier,
  Currency,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
} from "@maria-matera/shared";

/**
 * Immutable order snapshot. Everything that could later drift in the catalog
 * (item name/price) or the customer's profile (address) is copied by *value* at
 * creation time, so a historical order never mutates when a product is re-priced
 * or an address is edited/deleted. Prices are stored in cents (integers) — never
 * floats — so money math is exact.
 *
 * `idempotencyKey` makes checkout safe to retry: a compound unique index on
 * `{customerId, idempotencyKey}` guarantees a given customer can never create
 * two orders for the same key (anti double-charge / anti double-click), while
 * still allowing two different customers to reuse the same client-supplied key.
 */

interface OrderAddressSnapshot {
  label: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  // CFDI (Mexican tax-invoice) fields — snapshotted if the source address had them.
  rfc?: string;
  cfdiUse?: string;
  taxRegime?: string;
  // Shipping-label contact, typed at checkout time — not part of the customer's
  // saved address book (see `Customer.addresses`). Left unset on the billing
  // snapshot.
  recipientName?: string;
  phone?: string;
}

interface OrderItemSnapshot {
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
}

interface OrderPayment {
  provider: PaymentProvider;
  ref?: string;
  status: PaymentStatus;
}

interface OrderStatusHistoryEntry {
  from: OrderStatus;
  to: OrderStatus;
  by: string;
  reason?: string;
  at: Date;
}

// If you add a field here, also update the manual reset in `applyTransition`
// (order.service.ts) that clears every field for the `shippingPatch === null`
// (shipment-revert) case — it enumerates these fields by hand.
interface OrderShipping {
  carrier?: Carrier;
  trackingNumber?: string;
  shippedAt?: Date;
  deliveredAt?: Date;
}

interface OrderDocument extends Document {
  customerId: Types.ObjectId;
  orderNumber: string;
  items: OrderItemSnapshot[];
  shippingAddress: OrderAddressSnapshot;
  billingAddress: OrderAddressSnapshot;
  subtotalCents: number;
  shippingCostCents: number;
  discountCents?: number;
  couponCode?: string;
  totalCents: number;
  currency: Currency;
  status: OrderStatus;
  statusHistory: OrderStatusHistoryEntry[];
  payment: OrderPayment;
  shipping: OrderShipping;
  idempotencyKey: string;
  reservationId: Types.ObjectId;
  reservationExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const orderAddressSchema = new Schema<OrderAddressSnapshot>(
  {
    label: { type: String, required: true },
    line1: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    country: { type: String, required: true },
    rfc: { type: String },
    cfdiUse: { type: String },
    taxRegime: { type: String },
    recipientName: { type: String },
    phone: { type: String },
  },
  { _id: false },
);

const orderItemSchema = new Schema<OrderItemSnapshot>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    lineSubtotalCents: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const orderPaymentSchema = new Schema<OrderPayment>(
  {
    provider: { type: String, enum: Object.values(PaymentProvider), required: true },
    ref: { type: String },
    status: {
      type: String,
      enum: Object.values(PaymentStatus),
      default: PaymentStatus.Pending,
    },
  },
  { _id: false },
);

const orderShippingSchema = new Schema<OrderShipping>(
  {
    carrier: { type: String, enum: Object.values(Carrier) },
    trackingNumber: { type: String },
    shippedAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { _id: false },
);

const statusHistorySchema = new Schema<OrderStatusHistoryEntry>(
  {
    from: { type: String, enum: Object.values(OrderStatus), required: true },
    to: { type: String, enum: Object.values(OrderStatus), required: true },
    by: { type: String, required: true },
    reason: { type: String },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema<OrderDocument>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    orderNumber: { type: String, required: true, unique: true },
    items: { type: [orderItemSchema], required: true },
    shippingAddress: { type: orderAddressSchema, required: true },
    billingAddress: { type: orderAddressSchema, required: true },
    subtotalCents: { type: Number, required: true, min: 0 },
    shippingCostCents: { type: Number, required: true, min: 0 },
    discountCents: { type: Number, min: 0 },
    couponCode: { type: String },
    totalCents: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: Object.values(Currency), default: Currency.Mxn },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PendingPayment,
      index: true,
    },
    statusHistory: { type: [statusHistorySchema], default: [] },
    payment: { type: orderPaymentSchema, required: true },
    shipping: { type: orderShippingSchema, default: {} },
    idempotencyKey: { type: String, required: true },
    reservationId: { type: Schema.Types.ObjectId, ref: "StockReservation", required: true },
    reservationExpiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Anti double-charge: one order per (customer, idempotencyKey). Scoped by
// customer so distinct customers may reuse the same client-supplied key.
orderSchema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });
// Backs `listMine` (newest first) and admin listing.
orderSchema.index({ customerId: 1, createdAt: -1 });
// Sparse: most orders have no tracking number yet. Backs the public tracking
// lookup (GET /api/v1/tracking/:trackingNumber).
orderSchema.index({ "shipping.trackingNumber": 1 }, { sparse: true });

const Order: Model<OrderDocument> =
  (models.Order as Model<OrderDocument>) ?? model<OrderDocument>("Order", orderSchema);

export type {
  OrderDocument,
  OrderAddressSnapshot,
  OrderItemSnapshot,
  OrderPayment,
  OrderStatusHistoryEntry,
  OrderShipping,
};
export { Order };
