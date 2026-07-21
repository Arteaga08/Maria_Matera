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

describe("createOrderSchema — recipientName/phone", () => {
  const basePayload = {
    idempotencyKey: "idempotency-key-123",
    shippingAddressId: "507f1f77bcf86cd799439011",
    billingAddressId: "507f1f77bcf86cd799439011",
  };

  it("accepts valid recipientName/phone", () => {
    const { error, value } = createOrderSchema.validate({
      ...basePayload,
      recipientName: "Juan Pérez",
      phone: "5512345678",
    });

    expect(error).toBeUndefined();
    expect(value.recipientName).toBe("Juan Pérez");
    expect(value.phone).toBe("5512345678");
  });

  it("is valid without recipientName/phone (backward compatible)", () => {
    const { error, value } = createOrderSchema.validate(basePayload);

    expect(error).toBeUndefined();
    expect(value.recipientName).toBeUndefined();
    expect(value.phone).toBeUndefined();
  });

  it("rejects a recipientName over 100 characters", () => {
    const { error } = createOrderSchema.validate({
      ...basePayload,
      recipientName: "a".repeat(101),
    });

    expect(error).toBeDefined();
    expect(error?.details[0]?.message).toBe(
      "El nombre del destinatario no puede exceder 100 caracteres.",
    );
  });

  it("rejects a phone over 20 characters", () => {
    const { error } = createOrderSchema.validate({
      ...basePayload,
      phone: "1".repeat(21),
    });

    expect(error).toBeDefined();
    expect(error?.details[0]?.message).toBe("El teléfono no es válido.");
  });
});
