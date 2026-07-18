import { Schema, model, models, Types, type Document, type Model } from "mongoose";

/**
 * Store-wide settings singleton. Exactly one document is ever expected to
 * exist, at the fixed `SETTINGS_ID` below — read/upserted via
 * `settings.service.ts`'s `get()`, which does a race-safe
 * `findByIdAndUpdate(SETTINGS_ID, {}, { upsert: true })`. Because `_id` is
 * always uniquely indexed, two concurrent first-reads can never both create a
 * document — MongoDB itself is the atomicity guard, not application code.
 *
 * Deliberately minimal: this is a single-price B2C storefront — no wholesale
 * tiers, no promotions engine — so only shipping config lives here for now.
 *
 * `freeShippingThreshold` defaults to 0 (cents): since every subtotal is
 * >= 0, this means "shipping is free unconditionally" until an admin sets a
 * real threshold. `shippingFlatFee` defaults to 0 for the same reason — there
 * is no admin-editable value yet, so a nonzero default would be an
 * unconfigurable magic number.
 */

const SETTINGS_ID = new Types.ObjectId("000000000000000000000001");

interface SettingsDocument extends Document {
  freeShippingThreshold: number;
  shippingFlatFee: number;
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<SettingsDocument>(
  {
    freeShippingThreshold: { type: Number, default: 0, min: 0 },
    shippingFlatFee: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

const Settings: Model<SettingsDocument> =
  (models.Settings as Model<SettingsDocument>) ??
  model<SettingsDocument>("Settings", settingsSchema);

export type { SettingsDocument };
export { Settings, SETTINGS_ID };
