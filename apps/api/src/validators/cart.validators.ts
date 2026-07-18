import Joi from "joi";

/**
 * Joi schemas for the customer cart. `productId`/`variantId` are Mongo
 * ObjectId strings; `qty` must be a positive integer (no zero/negative/
 * fractional quantities).
 */

const productId = Joi.string()
  .trim()
  .hex()
  .length(24)
  .messages({
    "string.hex": "El producto indicado no es válido.",
    "string.length": "El producto indicado no es válido.",
    "string.empty": "El producto es obligatorio.",
    "any.required": "El producto es obligatorio.",
  });

const variantId = Joi.string()
  .trim()
  .hex()
  .length(24)
  .messages({
    "string.hex": "La variante indicada no es válida.",
    "string.length": "La variante indicada no es válida.",
    "string.empty": "La variante es obligatoria.",
    "any.required": "La variante es obligatoria.",
  });

const qty = Joi.number().integer().min(1).messages({
  "number.base": "La cantidad debe ser un número entero mayor a cero.",
  "number.integer": "La cantidad debe ser un número entero mayor a cero.",
  "number.min": "La cantidad debe ser al menos 1.",
  "any.required": "La cantidad es obligatoria.",
});

const addItemSchema = Joi.object({
  productId: productId.required(),
  variantId: variantId.required(),
  qty: qty.required(),
});

const updateItemSchema = Joi.object({
  qty: qty.required(),
});

export { addItemSchema, updateItemSchema };
