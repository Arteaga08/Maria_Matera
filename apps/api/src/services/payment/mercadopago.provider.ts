import crypto from "node:crypto";
import { MercadoPagoConfig, Payment, PaymentRefund, Preference } from "mercadopago";
import { PaymentStatus } from "@maria-matera/shared";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../utils/AppError.js";
import type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  RetrievePaymentIntentResult,
} from "./payment.provider.js";

/**
 * Concrete Mercado Pago (Checkout Pro) adapter for the provider-agnostic
 * `PaymentProvider` contract. Mirrors `stripe.provider.ts`'s structure: a
 * module-level SDK singleton (NOT dependency injection), a private `toAppError`
 * that maps SDK failures onto operational `AppError`s, and every method wrapped
 * in try/catch. All `mercadopago` SDK types stay contained in this file.
 *
 * CORRELATION CONTRACT: unlike Stripe, Mercado Pago separates the upfront
 * hosted *preference* from the *payment* created when the buyer pays. To keep
 * `order.service`'s `*ByPaymentRef` seam unchanged, EVERYTHING correlates by
 * the order id via `external_reference`: `payment.ref === order.id ===
 * preference.external_reference`. So `createPaymentIntent` returns the ORDER
 * ID as `ref` (not the preference id), and retrieve/refund/getPaymentById all
 * resolve payments through `external_reference`.
 */

const client = new MercadoPagoConfig({ accessToken: env.mercadoPagoAccessToken });
const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);
const refundClient = new PaymentRefund(client);

const PAYMENT_UNAVAILABLE = "El servicio de pagos no está disponible temporalmente. Intenta más tarde.";
const PAYMENT_DECLINED = "El pago fue rechazado por el proveedor de pagos.";
const PAYMENT_UPSTREAM = "No se pudo procesar el pago con el proveedor.";

// Lenient replay window (~5 min) for webhook timestamps; MP's `ts` is epoch ms.
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Translates a raw Mercado Pago SDK failure into an operational `AppError`,
 * mirroring Stripe's tiers. The SDK's REST client throws the parsed JSON error
 * body (a plain object carrying a numeric `status`) on non-2xx responses, and a
 * native `TypeError`/`AbortError` on network/timeout failures — there are no
 * typed SDK error classes to `instanceof`, so we inspect the shape instead:
 * transient/infra (5xx, 429, network, timeout) -> 503; a rejected payment ->
 * 402; any other MP API error -> 502. `AppError`s we raised ourselves and any
 * non-MP error are returned untouched so genuine bugs still surface as 500.
 */
const toAppError = (error: unknown): unknown => {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error) {
    // `fetch` rejects with a TypeError on network failure and an AbortError
    // (DOMException) when the per-request timeout aborts the controller.
    if (error instanceof TypeError || error.name === "AbortError") {
      return new AppError(PAYMENT_UNAVAILABLE, 503);
    }
    return error;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      if (status >= 500 || status === 429) {
        return new AppError(PAYMENT_UNAVAILABLE, 503);
      }
      if (status === 402) {
        return new AppError(PAYMENT_DECLINED, 402);
      }
      return new AppError(PAYMENT_UPSTREAM, 502);
    }
  }
  return error;
};

/**
 * Maps a single raw Mercado Pago payment status onto the canonical
 * `PaymentStatus` every adapter must return, so `order.service` never compares
 * against an MP-specific literal.
 */
const toCanonicalStatus = (mpStatus: string | undefined): PaymentStatus => {
  switch (mpStatus) {
    case "approved":
      return PaymentStatus.Paid;
    case "refunded":
    case "charged_back":
      return PaymentStatus.Refunded;
    case "rejected":
    case "cancelled":
      return PaymentStatus.Failed;
    case "pending":
    case "in_process":
    case "in_mediation":
    case "authorized":
    default:
      return PaymentStatus.Pending;
  }
};

/**
 * Collapses the (usually one) payments sharing an `external_reference` into a
 * single canonical status, in the priority documented by the contract:
 * approved -> Paid; else refunded/charged_back -> Refunded; else
 * rejected/cancelled -> Failed; else (pending/in_process/none) -> Pending.
 */
const aggregateStatus = (statuses: Array<string | undefined>): PaymentStatus => {
  const canonical = statuses.map(toCanonicalStatus);
  if (canonical.includes(PaymentStatus.Paid)) {
    return PaymentStatus.Paid;
  }
  if (canonical.includes(PaymentStatus.Refunded)) {
    return PaymentStatus.Refunded;
  }
  if (canonical.includes(PaymentStatus.Failed)) {
    return PaymentStatus.Failed;
  }
  return PaymentStatus.Pending;
};

/**
 * Resolves the Checkout Pro `init_point` (the URL `finalizePayment`'s retry
 * path hands back to the client) for an order. The preference SEARCH summary
 * does not include `init_point`, so we search by `external_reference` to get
 * the preference id, then `get` the full preference. Returns `undefined` when
 * no preference exists for the order.
 */
const findPreferenceInitPoint = async (
  externalReference: string,
): Promise<string | undefined> => {
  const search = await preferenceClient.search({
    options: { external_reference: externalReference },
  });
  const element = search.elements?.[0];
  if (!element) {
    return undefined;
  }
  const preference = await preferenceClient.get({ preferenceId: element.id });
  return preference.init_point;
};

const createPaymentIntent = async (
  input: CreatePaymentIntentInput,
): Promise<CreatePaymentIntentResult> => {
  const orderId = input.metadata?.orderId;
  if (!orderId) {
    // orderService always supplies orderId; this guards the correlation invariant.
    throw new AppError("Falta el identificador de la orden para crear el pago.", 500);
  }

  try {
    const preference = await preferenceClient.create({
      body: {
        items: [
          {
            id: orderId,
            title: "Pedido Maria Matera",
            quantity: 1,
            // MP uses MAJOR units (pesos); our amounts are integer cents.
            unit_price: input.amountCents / 100,
            currency_id: input.currency,
          },
        ],
        // Primary correlation link back to the order.
        external_reference: orderId,
        // Defensive secondary link; external_reference is authoritative.
        metadata: { order_id: orderId },
        back_urls: {
          success: `${env.appUrl}/checkout/exito`,
          failure: `${env.appUrl}/checkout/error`,
          pending: `${env.appUrl}/checkout/pendiente`,
        },
        auto_return: "approved",
      },
      // Per-order idempotency: a network retry returns the same preference.
      requestOptions: { idempotencyKey: input.idempotencyKey },
    });

    return { ref: orderId, clientSecret: preference.init_point ?? "" };
  } catch (error) {
    throw toAppError(error);
  }
};

const retrievePaymentIntent = async (ref: string): Promise<RetrievePaymentIntentResult> => {
  const search = await paymentClient
    .search({ options: { external_reference: ref } })
    .catch((error: unknown) => {
      throw toAppError(error);
    });
  const status = aggregateStatus((search.results ?? []).map((payment) => payment.status));

  // The init_point lookup is best-effort: `reconcilePendingOrders` only needs
  // `status` to sweep an order, so a transient failure here must never make
  // the whole retrieve throw (which would skip that order for the sweep).
  const clientSecret = await findPreferenceInitPoint(ref).catch((error: unknown) => {
    logger.warn({ err: error, ref }, "No se pudo obtener el init_point de la preferencia de Mercado Pago.");
    return undefined;
  });

  return {
    ref,
    status,
    ...(clientSecret ? { clientSecret } : {}),
  };
};

const refund = async (ref: string): Promise<void> => {
  try {
    const search = await paymentClient.search({ options: { external_reference: ref } });
    const approved = (search.results ?? []).find((payment) => payment.status === "approved");
    if (!approved?.id) {
      throw new AppError("No se encontró un pago aprobado para reembolsar.", 404);
    }
    await refundClient.total({ payment_id: approved.id });
  } catch (error) {
    throw toAppError(error);
  }
};

/** Parses MP's `x-signature` header (`ts=<ts>,v1=<hex>`) into its parts. */
const parseSignatureHeader = (header: string): { ts?: string; v1?: string } => {
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts") {
      ts = value;
    } else if (key === "v1") {
      v1 = value;
    }
  }
  return { ts, v1 };
};

/**
 * Builds MP's signed manifest exactly as the official SDK does
 * (`id:<dataId>;request-id:<requestId>;ts:<ts>;`), omitting any segment whose
 * value is absent. NOTE: the official SDK does NOT lowercase `data.id`, so we
 * don't either (payment notifications carry a numeric id regardless).
 */
const buildWebhookManifest = (dataId?: string, requestId?: string, ts?: string): string => {
  const parts: string[] = [];
  if (dataId) {
    parts.push(`id:${dataId}`);
  }
  if (requestId) {
    parts.push(`request-id:${requestId}`);
  }
  if (ts) {
    parts.push(`ts:${ts}`);
  }
  return parts.length > 0 ? `${parts.join(";")};` : "";
};

const constructWebhookEvent = (
  rawBody: Buffer,
  signature: string | undefined,
  meta?: { requestId?: string; dataId?: string },
): PaymentWebhookEvent => {
  const invalid = (): AppError => new AppError("Firma de webhook inválida.", 400);

  if (!signature) {
    throw invalid();
  }
  const { ts, v1 } = parseSignatureHeader(signature);
  if (!ts || !v1) {
    throw invalid();
  }

  // Lenient replay guard: reject timestamps drifting more than ~5 min from now.
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > WEBHOOK_TOLERANCE_MS) {
    throw invalid();
  }

  const manifest = buildWebhookManifest(meta?.dataId, meta?.requestId, ts);
  const expected = crypto
    .createHmac("sha256", env.mercadoPagoWebhookSecret)
    .update(manifest)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(v1, "hex");
  // `timingSafeEqual` requires equal-length buffers; a length mismatch is itself
  // a verification failure.
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw invalid();
  }

  const dataId = meta?.dataId ?? "";
  let type = "unknown";
  let notificationId = "";
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as { type?: unknown; id?: unknown };
    if (typeof parsed.type === "string" && parsed.type.length > 0) {
      type = parsed.type;
    }
    if (parsed.id !== undefined && parsed.id !== null) {
      notificationId = String(parsed.id);
    }
  } catch {
    // Body is already authenticated; an unparseable payload just leaves the
    // event type as "unknown" rather than throwing.
  }

  // Dedup key = MP's unique per-notification `id` (from the body), NOT the
  // payment id (`data.id`): Mercado Pago sends several notifications sharing one
  // payment id as the payment's status changes (pending -> approved), so
  // deduping by payment id would drop the approval. Falls back to the payment
  // id only if the body carries no notification id. Namespaced so it never
  // collides with a Stripe id in the shared ProcessedWebhookEvent ledger. The
  // actual payment lookup happens in the webhook controller via getPaymentById.
  const eventId = notificationId || dataId;
  return {
    id: `mercadopago:${eventId}`,
    type,
    data: { object: { id: dataId } },
  };
};

/**
 * Mercado-Pago-specific helper (beyond the shared `PaymentProvider` interface)
 * for the webhook controller, which imports this adapter directly. Fetches a
 * payment by its MP id and returns the canonical status plus its
 * `external_reference` (the order id) so the controller can correlate.
 */
const getPaymentById = async (
  paymentId: string,
): Promise<{ status: PaymentStatus; orderId: string }> => {
  try {
    const payment = await paymentClient.get({ id: paymentId });
    return {
      status: toCanonicalStatus(payment.status),
      orderId: payment.external_reference ?? "",
    };
  } catch (error) {
    throw toAppError(error);
  }
};

const mercadopagoProvider: PaymentProvider & {
  getPaymentById(paymentId: string): Promise<{ status: PaymentStatus; orderId: string }>;
} = {
  createPaymentIntent,
  retrievePaymentIntent,
  refund,
  constructWebhookEvent,
  getPaymentById,
};

export { mercadopagoProvider };
