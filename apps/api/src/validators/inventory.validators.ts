import Joi from "joi";

/**
 * Joi schema for the admin stock-adjustment endpoint. `onHand` is an absolute
 * integer count (not a delta).
 */

const adjustStockSchema = Joi.object({
  onHand: Joi.number().integer().min(0).required().messages({
    "number.base": "La existencia debe ser un número entero.",
    "number.min": "La existencia no puede ser negativa.",
    "any.required": "Indica la nueva existencia (onHand).",
  }),
});

export { adjustStockSchema };
