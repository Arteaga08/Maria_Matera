import Stripe from "stripe";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  RetrievePaymentIntentResult,
} from "./payment.provider.js";

/**
 * Concrete Stripe adapter for the provider-agnostic `PaymentProvider` contract.
 * A single module-level client (mirroring `config/cloudinary.ts`'s singleton
 * convention — NOT dependency injection) built from `env.stripeSecretKey`.
 * All Stripe SDK types are contained inside this file; callers only ever see
 * the neutral DTOs from `payment.provider.ts`.
 */

const stripe = new Stripe(env.stripeSecretKey);

const PAYMENT_UNAVAILABLE = "No pudimos contactar al proveedor de pagos, intenta de nuevo.";

/**
 * Translates a raw Stripe SDK exception into an operational `AppError` so the
 * global error handler returns a meaningful status/message instead of an opaque
 * generic 500. Transient/infra failures map to 503 (retry-appropriate at
 * checkout); a declined card maps to 402; anything else Stripe-shaped maps to
 * 502 (an upstream failure we did not cause and cannot fix by retrying blindly).
 * Non-Stripe errors are returned untouched so genuine bugs still surface as 500.
 */
const toAppError = (error: unknown): unknown => {
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return new AppError(PAYMENT_UNAVAILABLE, 503);
  }
  if (error instanceof Stripe.errors.StripeCardError) {
    return new AppError("El pago fue rechazado por el proveedor de pagos.", 402);
  }
  if (error instanceof Stripe.errors.StripeError) {
    // Invalid-request / authentication / idempotency-conflict / signature errors:
    // an upstream payment failure from our perspective.
    return new AppError("No se pudo procesar el pago con el proveedor.", 502);
  }
  return error;
};

const createPaymentIntent = async (
  input: CreatePaymentIntentInput,
): Promise<CreatePaymentIntentResult> => {
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        automatic_payment_methods: { enabled: true },
      },
      // Per-order idempotency: a network retry of this exact call returns the same
      // PaymentIntent instead of creating a duplicate.
      { idempotencyKey: input.idempotencyKey },
    );

    return { ref: intent.id, clientSecret: intent.client_secret ?? "" };
  } catch (error) {
    throw toAppError(error);
  }
};

const retrievePaymentIntent = async (ref: string): Promise<RetrievePaymentIntentResult> => {
  try {
    const intent = await stripe.paymentIntents.retrieve(ref);
    return {
      ref: intent.id,
      status: intent.status,
      ...(intent.client_secret ? { clientSecret: intent.client_secret } : {}),
    };
  } catch (error) {
    throw toAppError(error);
  }
};

const refund = async (ref: string): Promise<void> => {
  try {
    await stripe.refunds.create({ payment_intent: ref });
  } catch (error) {
    throw toAppError(error);
  }
};

const constructWebhookEvent = (
  rawBody: Buffer,
  signature: string | undefined,
): PaymentWebhookEvent => {
  try {
    // Stripe's SDK verifies the signature AND enforces a ~5min timestamp
    // tolerance against replay; it throws on any mismatch. `signature ?? ""`
    // keeps a missing header on the throwing path (never silently accepted).
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature ?? "",
      env.stripeWebhookSecret,
    );
    return event as unknown as PaymentWebhookEvent;
  } catch (error) {
    // The webhook controller treats ANY throw here as a signature failure (400),
    // so the mapped AppError never masks that; this keeps the message consistent
    // if the error ever surfaces elsewhere.
    throw toAppError(error);
  }
};

const stripeProvider: PaymentProvider = {
  createPaymentIntent,
  retrievePaymentIntent,
  refund,
  constructWebhookEvent,
};

export { stripeProvider };
