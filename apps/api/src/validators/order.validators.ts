import Joi from "joi";
import { OrderStatus, PaymentProvider } from "@maria-matera/shared";

/**
 * Joi schemas for orders. `idempotencyKey` is a client-supplied token that makes
 * checkout safe to retry (see `Order` model). Address ids are Mongo ObjectId
 * strings. Admin status changes are constrained to the known `OrderStatus` set.
 */

const objectId = (label: string) =>
  Joi.string()
    .trim()
    .hex()
    .length(24)
    .messages({
      "string.hex": `${label} no es válido.`,
      "string.length": `${label} no es válido.`,
      "string.empty": `${label} es obligatorio.`,
      "any.required": `${label} es obligatorio.`,
    });

const idempotencyKey = Joi.string()
  .trim()
  .min(8)
  .max(200)
  .messages({
    "string.empty": "La clave de idempotencia es obligatoria.",
    "string.min": "La clave de idempotencia no es válida.",
    "string.max": "La clave de idempotencia no es válida.",
    "any.required": "La clave de idempotencia es obligatoria.",
  });

const couponCode = Joi.string().trim().max(40).messages({
  "string.max": "El código de cupón no es válido.",
});

const paymentProvider = Joi.string()
  .valid(...Object.values(PaymentProvider))
  .default(PaymentProvider.Stripe)
  .messages({
    "any.only": "El método de pago no es válido.",
  });

const createOrderSchema = Joi.object({
  idempotencyKey: idempotencyKey.required(),
  shippingAddressId: objectId("La dirección de envío").required(),
  billingAddressId: objectId("La dirección de facturación").required(),
  couponCode: couponCode.optional(),
  paymentProvider: paymentProvider.optional(),
});

const advanceOrderSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(OrderStatus))
    .required()
    .messages({
      "any.only": "El estado indicado no es válido.",
      "any.required": "El estado es obligatorio.",
    }),
  reason: Joi.string().trim().max(500).optional().messages({
    "string.max": "El motivo no puede exceder 500 caracteres.",
  }),
});

const refundOrderSchema = Joi.object({
  reason: Joi.string().trim().max(500).required().messages({
    "string.empty": "El motivo del reembolso es obligatorio.",
    "string.max": "El motivo no puede exceder 500 caracteres.",
    "any.required": "El motivo del reembolso es obligatorio.",
  }),
});

export { createOrderSchema, advanceOrderSchema, refundOrderSchema };
