import Joi from "joi";

/**
 * Joi schemas for product variants. SKU is auto-generated and stock is managed
 * via the dedicated inventory endpoint, so neither is accepted here.
 */

const attributes = Joi.object().pattern(
  Joi.string().max(40),
  Joi.string().max(120),
);

const createVariantSchema = Joi.object({
  size: Joi.string().trim().max(40).allow(""),
  material: Joi.string().trim().max(80).allow(""),
  priceCentsOverride: Joi.number().integer().min(0),
  attributes,
});

const updateVariantSchema = Joi.object({
  size: Joi.string().trim().max(40).allow(""),
  material: Joi.string().trim().max(80).allow(""),
  priceCentsOverride: Joi.number().integer().min(0),
  attributes,
})
  .min(1)
  .messages({ "object.min": "Envía al menos un campo para actualizar." });

export { createVariantSchema, updateVariantSchema };
