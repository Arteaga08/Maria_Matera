import Joi from "joi";

/**
 * Joi schema for the public product-view ingest. Only shape validation lives
 * here (hex24) — whether the product actually exists and is sellable is
 * checked in the service, which deliberately stays silent on mismatches so
 * the public endpoint can't be used to enumerate the catalog.
 */

const productViewSchema = Joi.object({
  productId: Joi.string().hex().length(24).required().messages({
    "string.hex": "El identificador de producto no es válido.",
    "string.length": "El identificador de producto no es válido.",
    "any.required": "El identificador de producto es obligatorio.",
  }),
});

export { productViewSchema };
