import { describe, expect, it } from "vitest";
import { PaymentProvider } from "@maria-matera/shared";
import { createOrderSchema } from "../../src/validators/order.validators.js";

describe("createOrderSchema — paymentProvider", () => {
  const basePayload = {
    idempotencyKey: "idempotency-key-123",
    shippingAddressId: "507f1f77bcf86cd799439011",
    billingAddressId: "507f1f77bcf86cd799439011",
  };

  it("accepts a valid paymentProvider", () => {
    const { error, value } = createOrderSchema.validate({
      ...basePayload,
      paymentProvider: PaymentProvider.MercadoPago,
    });

    expect(error).toBeUndefined();
    expect(value.paymentProvider).toBe(PaymentProvider.MercadoPago);
  });

  it("rejects an invalid paymentProvider", () => {
    const { error } = createOrderSchema.validate({
      ...basePayload,
      paymentProvider: "paypal",
    });

    expect(error).toBeDefined();
    expect(error?.details[0]?.message).toBe("El método de pago no es válido.");
  });

  it("defaults paymentProvider to stripe when omitted", () => {
    const { error, value } = createOrderSchema.validate(basePayload);

    expect(error).toBeUndefined();
    expect(value.paymentProvider).toBe(PaymentProvider.Stripe);
  });
});
