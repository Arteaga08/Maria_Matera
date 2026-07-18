import Joi from "joi";

/**
 * Joi schemas for the customer address book. `zip` is checked against the
 * Mexican 5-digit postal code format (judgment call — the storefront ships
 * to Mexico only for now; revisit if international shipping is added).
 * `rfc`/`cfdiUse`/`taxRegime` are plain optional strings: no format validation
 * yet, they're unused until the future CFDI/timbrado phase.
 */

const label = Joi.string().trim().max(60).messages({
  "string.empty": "El nombre de la dirección es obligatorio.",
  "string.max": "El nombre de la dirección no puede exceder 60 caracteres.",
  "any.required": "El nombre de la dirección es obligatorio.",
});

const line1 = Joi.string().trim().max(200).messages({
  "string.empty": "La calle y número son obligatorios.",
  "string.max": "La dirección no puede exceder 200 caracteres.",
  "any.required": "La calle y número son obligatorios.",
});

const city = Joi.string().trim().max(100).messages({
  "string.empty": "La ciudad es obligatoria.",
  "string.max": "La ciudad no puede exceder 100 caracteres.",
  "any.required": "La ciudad es obligatoria.",
});

const state = Joi.string().trim().max(100).messages({
  "string.empty": "El estado es obligatorio.",
  "string.max": "El estado no puede exceder 100 caracteres.",
  "any.required": "El estado es obligatorio.",
});

const zip = Joi.string()
  .trim()
  .pattern(/^\d{5}$/)
  .messages({
    "string.pattern.base": "El código postal debe tener 5 dígitos.",
    "string.empty": "El código postal es obligatorio.",
    "any.required": "El código postal es obligatorio.",
  });

const country = Joi.string().trim().max(60).messages({
  "string.max": "El país no puede exceder 60 caracteres.",
});

const isDefaultShipping = Joi.boolean().messages({
  "boolean.base": "Indica si es la dirección de envío predeterminada.",
});

const isDefaultBilling = Joi.boolean().messages({
  "boolean.base": "Indica si es la dirección de facturación predeterminada.",
});

const rfc = Joi.string().trim().uppercase().max(13).messages({
  "string.max": "El RFC no puede exceder 13 caracteres.",
});

const cfdiUse = Joi.string().trim().uppercase().max(10).messages({
  "string.max": "El uso de CFDI no puede exceder 10 caracteres.",
});

const taxRegime = Joi.string().trim().max(10).messages({
  "string.max": "El régimen fiscal no puede exceder 10 caracteres.",
});

const createAddressSchema = Joi.object({
  label: label.required(),
  line1: line1.required(),
  city: city.required(),
  state: state.required(),
  zip: zip.required(),
  country,
  isDefaultShipping,
  isDefaultBilling,
  rfc,
  cfdiUse,
  taxRegime,
});

const updateAddressSchema = Joi.object({
  label,
  line1,
  city,
  state,
  zip,
  country,
  isDefaultShipping,
  isDefaultBilling,
  rfc,
  cfdiUse,
  taxRegime,
})
  .min(1)
  .messages({ "object.min": "Envía al menos un campo para actualizar." });

export { createAddressSchema, updateAddressSchema };
