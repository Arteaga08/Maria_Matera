import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * Certificate of authenticity issued for a single order line item. Immutable
 * once issued: `orderItemSnapshot` and `specs` are copied by *value* at
 * issuance time (mirroring `Order.ts`'s snapshot convention) so a historical
 * certificate never drifts when the catalog changes later.
 *
 * The compound unique index on `{orderId, orderItemSnapshot.sku}` is the
 * idempotency guarantee the (future) service layer relies on: attempting to
 * issue a second certificate for the same order+sku throws a Mongo
 * duplicate-key error, which the service uses to detect "already issued".
 *
 * CAVEAT for that (future) consumer: this model declares TWO unique indexes —
 * the compound `{orderId, orderItemSnapshot.sku}` above AND the separate
 * unique `serialNumber` below — and BOTH raise the exact same Mongo error
 * code (`11000`) on violation. Naively treating any `code === 11000` as
 * "already issued, skip it" would misclassify a `serialNumber` collision (a
 * CSPRNG fluke that needs a retry with a fresh serial) as a legitimate
 * no-op and silently skip issuance. Any consumer catching this error MUST
 * inspect `err.keyPattern` (e.g. `err.keyPattern?.serialNumber` vs
 * `err.keyPattern?.orderId`) to tell the two cases apart before deciding
 * how to react.
 */

interface CertificateOrderItemSnapshot {
  sku: string;
  name: string;
  // Flattened from ProductVariant.attributes (a Map) at issuance time — plain
  // object, not a Map, for simple subdocument storage.
  attributes?: Record<string, string>;
}

interface CertificateSpecs {
  material?: string;
  stoneType?: string;
  stoneCarat?: number;
  size?: string;
}

interface CertificateDocument extends Document {
  orderId: Types.ObjectId;
  customerId: Types.ObjectId;
  orderItemSnapshot: CertificateOrderItemSnapshot;
  serialNumber: string;
  pdfUrl: string;
  publicId: string;
  specs?: CertificateSpecs;
  issuedAt: Date;
}

const certificateOrderItemSchema = new Schema<CertificateOrderItemSnapshot>(
  {
    sku: { type: String, required: true },
    name: { type: String, required: true },
    attributes: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const certificateSpecsSchema = new Schema<CertificateSpecs>(
  {
    material: { type: String },
    stoneType: { type: String },
    stoneCarat: { type: Number, min: 0 },
    size: { type: String },
  },
  { _id: false },
);

const certificateSchema = new Schema<CertificateDocument>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    orderItemSnapshot: { type: certificateOrderItemSchema, required: true },
    serialNumber: { type: String, required: true, unique: true },
    pdfUrl: { type: String, required: true },
    publicId: { type: String, required: true },
    specs: { type: certificateSpecsSchema },
    issuedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

// Idempotency guarantee: at most one certificate per order line item. NOTE:
// this raises the same 11000 duplicate-key code as the `serialNumber` unique
// index above — see the file-header caveat on distinguishing the two via
// `err.keyPattern`.
certificateSchema.index({ orderId: 1, "orderItemSnapshot.sku": 1 }, { unique: true });

const Certificate: Model<CertificateDocument> =
  (models.Certificate as Model<CertificateDocument>) ??
  model<CertificateDocument>("Certificate", certificateSchema);

export type { CertificateDocument, CertificateOrderItemSnapshot, CertificateSpecs };
export { Certificate };
