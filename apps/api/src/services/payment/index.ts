import { PaymentProvider } from "@maria-matera/shared";
import type { PaymentProvider as PaymentProviderPort } from "./payment.provider.js";
import { stripeProvider } from "./stripe.provider.js";
import { mercadopagoProvider } from "./mercadopago.provider.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Provider registry: the deny-by-default lookup `order.service` uses to
 * resolve the concrete adapter for an order's `payment.provider` enum value,
 * keeping it free of any direct adapter import — it only ever sees the
 * narrow `PaymentProviderPort` contract from `payment.provider.ts`. (The
 * `/webhooks/stripe` route still imports `stripeProvider` directly, since it
 * knows its provider statically; a future Mercado Pago webhook route could
 * use this registry too.)
 *
 * Stripe and Mercado Pago are both wired up; any other provider value is
 * unsupported and throws rather than silently falling back to a default.
 */
const getPaymentProvider = (provider: PaymentProvider): PaymentProviderPort => {
  switch (provider) {
    case PaymentProvider.Stripe:
      return stripeProvider;
    case PaymentProvider.MercadoPago:
      return mercadopagoProvider;
    default:
      throw new AppError("Proveedor de pago no soportado.", 500);
  }
};

export { getPaymentProvider };
