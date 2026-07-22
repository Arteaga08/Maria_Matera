import Joi from "joi";
import { CouponType } from "@maria-matera/shared";

/**
 * Joi schemas for coupon admin CRUD + public validation. `value` is required
 * for percent/fixed types (percent capped at 100) and ignored for free_shipping.
 */

const code = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9]{3,30}$/)
  .messages({
    "string.pattern.base": "El código debe tener de 3 a 30 caracteres (A-Z, 0-9).",
    "string.empty": "El código es obligatorio.",
    "any.required": "El código es obligatorio.",
  });

const value = Joi.when("type", {
  is: CouponType.Percent,
  then: Joi.number().integer().min(1).max(100).required().messages({
    "number.max": "El porcentaje no puede ser mayor a 100.",
    "any.required": "Indica el porcentaje de descuento.",
  }),
  otherwise: Joi.when("type", {
    is: CouponType.Fixed,
    then: Joi.number().integer().min(1).required().messages({
      "any.required": "Indica el monto de descuento (en centavos).",
    }),
    otherwise: Joi.number().integer().min(0).default(0),
  }),
});

const description = Joi.string().trim().max(280).messages({
  "string.max": "La descripción no puede superar los 280 caracteres.",
});

const createCouponSchema = Joi.object({
  code: code.required(),
  type: Joi.string()
    .valid(...Object.values(CouponType))
    .required()
    .messages({ "any.required": "Indica el tipo de cupón." }),
  value,
  description,
  minPurchaseCents: Joi.number().integer().min(0),
  maxRedemptions: Joi.number().integer().min(1),
  perUserLimit: Joi.number().integer().min(1),
  validFrom: Joi.date().iso().required(),
  validTo: Joi.date().iso().greater(Joi.ref("validFrom")).required().messages({
    "date.greater": "La fecha de fin debe ser posterior a la de inicio.",
  }),
  isVipOnly: Joi.boolean(),
  isActive: Joi.boolean(),
});

const updateCouponSchema = Joi.object({
  description,
  minPurchaseCents: Joi.number().integer().min(0),
  maxRedemptions: Joi.number().integer().min(1),
  perUserLimit: Joi.number().integer().min(1),
  validFrom: Joi.date().iso(),
  validTo: Joi.date().iso(),
  isVipOnly: Joi.boolean(),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({ "object.min": "Envía al menos un campo para actualizar." });

const validateCouponSchema = Joi.object({
  code: code.required(),
  subtotalCents: Joi.number().integer().min(0),
});

export { createCouponSchema, updateCouponSchema, validateCouponSchema };
