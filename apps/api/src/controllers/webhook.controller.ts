import type { Request, Response } from "express";
import { PaymentStatus } from "@maria-matera/shared";
import { logger } from "../config/logger.js";
import { ProcessedWebhookEvent } from "../models/ProcessedWebhookEvent.js";
import { stripeProvider } from "../services/payment/stripe.provider.js";
import { mercadopagoProvider } from "../services/payment/mercadopago.provider.js";
import type { PaymentWebhookEvent } from "../services/payment/payment.provider.js";
import * as orderService from "../services/order.service.js";

/**
 * Stripe payment webhook. Authenticated by Stripe's SIGNATURE over the raw body
 * (never cookies/origin), so this route is mounted before `express.json`,
 * `cookieParser`, sanitizers, `verifyOrigin` and the rate limiter, and reads the
 * body via `express.raw`. Flow: verify signature → dedupe by `event.id` →
 * dispatch → 2xx. A non-2xx makes Stripe retry, so we only ever return non-2xx
 * for a genuine signature failure (400) or an unexpected server error.
 */

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/**
 * Extracts the correlating PaymentIntent id from an event. For `payment_intent.*`
 * the intent IS the event object (`object.id`); for `charge.*` / dispute events
 * the intent is referenced by `object.payment_intent`.
 */
const paymentIntentIdOf = (event: PaymentWebhookEvent): string | undefined => {
  const object = event.data.object;
  if (event.type.startsWith("payment_intent.")) {
    return typeof object.id === "string" ? object.id : undefined;
  }
  return typeof object.payment_intent === "string" ? object.payment_intent : undefined;
};

/**
 * Routes a verified, de-duplicated event to the matching order transition.
 * Unhandled event types are acknowledged (2xx) without side effects.
 */
const dispatchEvent = async (event: PaymentWebhookEvent): Promise<void> => {
  const paymentIntentId = paymentIntentIdOf(event);
  const orderId =
    typeof event.data.object.metadata === "object" && event.data.object.metadata !== null
      ? (event.data.object.metadata as Record<string, unknown>).orderId
      : undefined;

  if (!paymentIntentId) {
    logger.warn({ eventId: event.id, type: event.type, orderId }, "Webhook sin PaymentIntent id.");
    return;
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      await orderService.markPaidByPaymentRef(paymentIntentId);
      break;

    case "payment_intent.payment_failed":
      // A failed ATTEMPT is NOT terminal: a Stripe PaymentIntent can be retried
      // and the SAME intent may still succeed. Cancelling (and releasing stock)
      // now, then a later `succeeded`, is a silent-money-loss path. So we do not
      // mutate here — a genuinely abandoned checkout is cancelled by
      // `reconcilePendingOrders` once its reservation expires.
      logger.info({ paymentIntentId, orderId }, "Intento de pago fallido (no terminal).");
      break;

    case "payment_intent.canceled":
      // The intent itself is terminally canceled (by us or Stripe) — safe to
      // cancel the order and release the held stock.
      await orderService.cancelByPaymentRef(paymentIntentId, "Pago cancelado.");
      break;

    case "charge.refunded": {
      // Stripe fires this for PARTIAL refunds too. This milestone scopes refunds
      // to total-only, so only a genuine full refund drives the order/stock
      // effect; a partial refund is acknowledged without mutation (full partial-
      // refund handling is out of scope) to avoid over-restocking.
      const amount = event.data.object.amount;
      const amountRefunded = event.data.object.amount_refunded;
      const isFullRefund =
        typeof amount === "number" && typeof amountRefunded === "number" && amountRefunded >= amount;
      if (!isFullRefund) {
        logger.warn(
          { paymentIntentId, amount, amountRefunded },
          "Reembolso parcial (fuera de alcance): sin mutación de orden/stock.",
        );
        break;
      }
      await orderService.refundByPaymentRef(paymentIntentId, "Reembolso total procesado en Stripe.");
      break;
    }

    case "charge.dispute.created":
      // A dispute being OPENED does not yet decide the outcome: the merchant may
      // still win, in which case restocking now would be a bug (the sale stands).
      // We therefore take NO stock/status effect here and wait for the resolution
      // in `charge.dispute.closed`. Acknowledged so Stripe stops retrying.
      logger.warn({ paymentIntentId, orderId }, "Contracargo abierto (sin efecto de stock aún).");
      break;

    case "charge.dispute.closed": {
      // Only a LOST dispute actually pulls the funds — treat it like a refund
      // (mark refunded + restock). A won/warning-closed dispute leaves the sale
      // and its stock effect intact.
      const outcome = event.data.object.status;
      if (outcome === "lost") {
        await orderService.refundByPaymentRef(paymentIntentId, "Contracargo perdido.");
      }
      break;
    }

    default:
      logger.debug({ eventId: event.id, type: event.type }, "Evento de webhook no manejado.");
  }
};

const stripeWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers["stripe-signature"];

  // 1. Verify the signature over the RAW body FIRST. Anything unverifiable is
  //    rejected 400 immediately with zero processing.
  let event: PaymentWebhookEvent;
  try {
    event = stripeProvider.constructWebhookEvent(
      req.body as Buffer,
      typeof signature === "string" ? signature : undefined,
    );
  } catch (error) {
    logger.warn({ err: error }, "Firma de webhook inválida.");
    res.status(400).json({ status: "fail", message: "Firma de webhook inválida." });
    return;
  }

  // 2. Dedupe by event id: Stripe delivers at-least-once. The unique index turns
  //    a re-delivery into an E11000 → already handled, answer 200 without
  //    reprocessing (a non-2xx would make Stripe keep retrying a done event).
  try {
    await ProcessedWebhookEvent.create({ eventId: event.id });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    throw error;
  }

  // 3. Process, then acknowledge. If dispatch throws, undo the dedupe insert
  //    first — otherwise a genuine Stripe retry of THIS delivery would be
  //    silently swallowed by the dedupe record that already exists, and the
  //    event would never be reprocessed.
  try {
    await dispatchEvent(event);
  } catch (error) {
    await ProcessedWebhookEvent.deleteOne({ eventId: event.id });
    throw error;
  }
  res.status(200).json({ received: true });
};

/** System actor label stamped on Mercado Pago webhook-driven history entries. */
const MP_WEBHOOK_ACTOR = "system:mercadopago-webhook";

/**
 * Extracts the MP payment id from the `data.id` query param (the key literally
 * contains a dot under Express's default query parser), falling back to the
 * notification body's `data.id` when the query omits it.
 */
const dataIdOf = (req: Request): string | undefined => {
  const fromQuery = req.query["data.id"];
  if (typeof fromQuery === "string") {
    return fromQuery;
  }
  try {
    const parsed = JSON.parse((req.body as Buffer).toString("utf8")) as { data?: { id?: unknown } };
    const id = parsed.data?.id;
    return id === undefined || id === null ? undefined : String(id);
  } catch {
    return undefined;
  }
};

/**
 * Mercado Pago payment webhook. Authenticated by MP's HMAC signature over a
 * manifest built from `x-signature` / `x-request-id` / `data.id` (never
 * cookies/origin), so — like `/stripe` — this route is mounted before
 * `express.json`, `cookieParser`, sanitizers, `verifyOrigin` and the rate
 * limiter, and reads the body via `express.raw`. Flow: verify signature →
 * ignore non-`payment` topics → dedupe by `event.id` → look up the payment →
 * dispatch → 2xx. A non-2xx makes Mercado Pago retry, so we only ever return
 * non-2xx for a genuine signature failure (400) or an unexpected server error.
 */
const mercadopagoWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers["x-signature"];
  const requestIdHeader = req.headers["x-request-id"];
  const requestId = typeof requestIdHeader === "string" ? requestIdHeader : undefined;
  const dataId = dataIdOf(req);

  // 1. Verify the signature over the RAW body FIRST. Anything unverifiable is
  //    rejected 400 immediately with zero processing.
  let event: PaymentWebhookEvent;
  try {
    event = mercadopagoProvider.constructWebhookEvent(
      req.body as Buffer,
      typeof signature === "string" ? signature : undefined,
      { requestId, dataId },
    );
  } catch (error) {
    logger.warn({ err: error }, "Firma de webhook inválida.");
    res.status(400).json({ status: "fail", message: "Firma de webhook inválida." });
    return;
  }

  // 2. MP sends several topics (`payment`, `merchant_order`, etc.) to the same
  //    URL; only `payment` correlates to an order transition here. Acknowledge
  //    the rest without deduping — there is no per-delivery side effect to
  //    guard against a re-send.
  if (event.type !== "payment") {
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  // 3. Dedupe by event id: MP delivers at-least-once (and even re-sends the
  //    SAME notification id on a slow response). The unique index turns a
  //    re-delivery into an E11000 → already handled, answer 200 without
  //    reprocessing.
  try {
    await ProcessedWebhookEvent.create({ eventId: event.id });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    throw error;
  }

  // 4. Process, then acknowledge. If dispatch throws, undo the dedupe insert
  //    first — otherwise a genuine MP retry of THIS delivery would be silently
  //    swallowed by the dedupe record that already exists, and the event
  //    would never be reprocessed.
  try {
    const paymentId = String(event.data.object.id);

    if (!paymentId) {
      // No usable `data.id` to look up — calling `getPaymentById("")` would
      // throw, triggering the dedupe rollback below and a 500 that MP would
      // retry forever for an event we can never resolve. Acknowledge instead;
      // the dedupe row from step 3 stays (harmless — this notification id is
      // genuinely handled, just with nothing to correlate).
      logger.warn({ eventId: event.id }, "Webhook de Mercado Pago sin id de pago.");
    } else {
      const { status, orderId } = await mercadopagoProvider.getPaymentById(paymentId);

      if (!orderId) {
        // No `external_reference` to correlate against — nothing we can do, and
        // NOT throwing avoids an infinite MP retry loop for an uncorrelatable event.
        logger.warn(
          { eventId: event.id, paymentId },
          "Webhook de Mercado Pago sin orden correlacionada.",
        );
      } else {
        switch (status) {
          case PaymentStatus.Paid:
            await orderService.markPaidByPaymentRef(orderId, MP_WEBHOOK_ACTOR);
            break;

          case PaymentStatus.Refunded:
            await orderService.refundByPaymentRef(
              orderId,
              "Reembolso procesado en Mercado Pago.",
              MP_WEBHOOK_ACTOR,
            );
            break;

          case PaymentStatus.Failed:
            // A failed ATTEMPT is NOT terminal: Mercado Pago Checkout Pro lets
            // the buyer retry with another card under the SAME
            // `external_reference`, so a later `Paid` notification for this
            // same order is entirely possible. Cancelling (and releasing
            // stock) now, then a later success, is a silent-money-loss path —
            // mirrors Stripe's `payment_intent.payment_failed` handling. A
            // genuinely abandoned checkout is cancelled by
            // `reconcilePendingOrders` once its reservation expires.
            logger.info(
              { eventId: event.id, orderId, status },
              "Intento de pago fallido en Mercado Pago (no terminal).",
            );
            break;

          default:
            // Pending / in_process / etc. is not terminal — a later notification
            // (or reconciliation) resolves it. No mutation.
            logger.debug(
              { eventId: event.id, orderId, status },
              "Pago de Mercado Pago no terminal.",
            );
        }
      }
    }
  } catch (error) {
    await ProcessedWebhookEvent.deleteOne({ eventId: event.id });
    throw error;
  }
  res.status(200).json({ received: true });
};

export { stripeWebhook, mercadopagoWebhook };
