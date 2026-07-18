import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import bcrypt from "bcryptjs";
import { CustomerTier } from "@maria-matera/shared";

/**
 * Customer account (storefront). Separate from AdminUser. The password is
 * `select: false` (never returned by default) and hashed with bcrypt (12 rounds)
 * in a pre-save hook only when it actually changed.
 */

const BCRYPT_ROUNDS = 12;

interface Address {
  _id: Types.ObjectId;
  label: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
  // CFDI (Mexican tax-invoice) fields — unused/unconsumed until the future
  // timbrado/CFDI phase. Plain optional strings, no format validation yet.
  rfc?: string;
  cfdiUse?: string;
  taxRegime?: string;
}

interface CustomerDocument extends Document {
  name: string;
  email: string;
  password: string;
  emailVerified: boolean;
  tier: CustomerTier;
  addresses: Types.DocumentArray<Address>;
  wishlist: Types.ObjectId[];
  marketingConsent: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const addressSchema = new Schema<Address>(
  {
    label: { type: String, required: true, trim: true, maxlength: 60 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    zip: { type: String, required: true, trim: true, maxlength: 20 },
    country: { type: String, required: true, trim: true, maxlength: 60, default: "México" },
    isDefaultShipping: { type: Boolean, default: false },
    isDefaultBilling: { type: Boolean, default: false },
    rfc: { type: String, trim: true, maxlength: 13 },
    cfdiUse: { type: String, trim: true, maxlength: 10 },
    taxRegime: { type: String, trim: true, maxlength: 10 },
  },
  { _id: true },
);

const customerSchema = new Schema<CustomerDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: false },
    tier: { type: String, enum: Object.values(CustomerTier), default: CustomerTier.Standard },
    addresses: { type: [addressSchema], default: [] },
    wishlist: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    marketingConsent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

customerSchema.pre("save", async function hashPassword(next) {
  if (!this.isModified("password")) {
    next();
    return;
  }
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
  next();
});

customerSchema.methods.comparePassword = async function comparePassword(
  this: CustomerDocument,
  candidate: string,
): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

const Customer: Model<CustomerDocument> =
  (models.Customer as Model<CustomerDocument>) ??
  model<CustomerDocument>("Customer", customerSchema);

export type { CustomerDocument, Address };
export { Customer };
