import { Schema, model, models, type Document, type Model } from "mongoose";
import { SubscriberStatus } from "@maria-matera/shared";

/**
 * Marketing newsletter subscriber. Double opt-in: created `pending` with a
 * hashed confirmation token; becomes `subscribed` once confirmed. Every
 * marketing email carries a one-click unsubscribe link keyed by
 * `unsubscribeToken`.
 */

interface SubscriberDocument extends Document {
  email: string;
  status: SubscriberStatus;
  consent: boolean;
  tags: string[];
  confirmTokenHash?: string;
  unsubscribeToken: string;
  createdAt: Date;
  updatedAt: Date;
}

const subscriberSchema = new Schema<SubscriberDocument>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    status: {
      type: String,
      enum: Object.values(SubscriberStatus),
      default: SubscriberStatus.Pending,
    },
    consent: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    confirmTokenHash: { type: String, select: false },
    unsubscribeToken: { type: String, required: true, unique: true, select: false },
  },
  { timestamps: true },
);

const Subscriber: Model<SubscriberDocument> =
  (models.Subscriber as Model<SubscriberDocument>) ??
  model<SubscriberDocument>("Subscriber", subscriberSchema);

export type { SubscriberDocument };
export { Subscriber };
