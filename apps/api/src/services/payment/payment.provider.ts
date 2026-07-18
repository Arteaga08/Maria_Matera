/**
 * Provider-agnostic payment gateway contract.
 *
 * This narrow interface is the ONLY surface `order.service` / the webhook
 * controller talk to, so a future Mercado Pago adapter (planned for M6) can
 * implement the exact same shape without any Stripe SDK type leaking into the
 * order/inventory logic. No `stripe` types appear in these signatures on
 * purpose — amounts are plain integer cents, statuses are provider-agnostic
 * strings, and the webhook event is reduced to the minimal fields every
 * gateway exposes (`id`, `type`, `data.object`).
 */

interface CreatePaymentIntentInput {
  amountCents: number;
  /** ISO 4217 code as stored on the order (e.g. "MXN"); the adapter normalizes casing. */
  currency: string;
  metadata?: Record<string, string>;
  /** Per-order key so a network retry of THIS call never mints a second intent. */
  idempotencyKey: string;
}

interface CreatePaymentIntentResult {
  /** Gateway reference persisted as `order.payment.ref`. */
  ref: string;
  /** Opaque secret the client SDK uses to confirm the payment. */
  clientSecret: string;
}

interface RetrievePaymentIntentResult {
  ref: string;
  /** Raw provider status string (e.g. Stripe: "succeeded", "processing", ...). */
  status: string;
  clientSecret?: string;
}

/**
 * The minimal webhook event shape the controller needs. Structurally satisfied
 * by Stripe's `Stripe.Event` (which also carries `id`, `type`, `data.object`),
 * so the Stripe adapter can return its verified event cast to this type.
 */
interface PaymentWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

interface PaymentProvider {
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<CreatePaymentIntentResult>;
  retrievePaymentIntent(ref: string): Promise<RetrievePaymentIntentResult>;
  refund(ref: string): Promise<void>;
  /**
   * Verifies the raw request body against the signature header and returns the
   * decoded event. MUST throw if verification fails (the caller responds 400).
   */
  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): PaymentWebhookEvent;
}

export type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  RetrievePaymentIntentResult,
  PaymentWebhookEvent,
  PaymentProvider,
};
