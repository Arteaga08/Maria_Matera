import { describe, expect, it } from "vitest";
import { PaymentProvider } from "@maria-matera/shared";
import { AppError } from "../../src/utils/AppError.js";
import { stripeProvider } from "../../src/services/payment/stripe.provider.js";
import { mercadopagoProvider } from "../../src/services/payment/mercadopago.provider.js";
import { getPaymentProvider } from "../../src/services/payment/index.js";

/**
 * Unit tests (Milestone 6, Task 2) for the payment-provider registry: the
 * single deny-by-default lookup `order.service` uses to resolve the concrete
 * adapter for an order's `payment.provider`, without importing any adapter
 * directly.
 */

describe("getPaymentProvider", () => {
  it("returns the Stripe singleton for PaymentProvider.Stripe", () => {
    expect(getPaymentProvider(PaymentProvider.Stripe)).toBe(stripeProvider);
  });

  it("returns the Mercado Pago singleton for PaymentProvider.MercadoPago", () => {
    expect(getPaymentProvider(PaymentProvider.MercadoPago)).toBe(mercadopagoProvider);
  });

  it("throws an AppError for an unsupported/unknown provider", () => {
    expect(() => getPaymentProvider("unknown-provider" as PaymentProvider)).toThrow(AppError);
    try {
      getPaymentProvider("unknown-provider" as PaymentProvider);
      throw new Error("expected getPaymentProvider to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(500);
      expect((err as AppError).message).toBe("Proveedor de pago no soportado.");
    }
  });
});
