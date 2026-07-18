import { Schema, model, models, type Document, type Model } from "mongoose";

/**
 * Idempotency ledger for inbound payment webhooks. Stripe delivers each event
 * at-least-once (it retries until it gets a 2xx), so the same `event.id` can
 * arrive multiple times. Inserting the id under a unique index makes reprocessing
 * a duplicate impossible: the second insert throws E11000, which the controller
 * treats as "already handled" and answers 200 without re-running side effects.
 */

interface ProcessedWebhookEventDocument extends Document {
  eventId: string;
  createdAt: Date;
}

const processedWebhookEventSchema = new Schema<ProcessedWebhookEventDocument>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const ProcessedWebhookEvent: Model<ProcessedWebhookEventDocument> =
  (models.ProcessedWebhookEvent as Model<ProcessedWebhookEventDocument>) ??
  model<ProcessedWebhookEventDocument>("ProcessedWebhookEvent", processedWebhookEventSchema);

export type { ProcessedWebhookEventDocument };
export { ProcessedWebhookEvent };
