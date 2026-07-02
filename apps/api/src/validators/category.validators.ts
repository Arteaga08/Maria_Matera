import Joi from "joi";

/**
 * Joi schemas for category admin CRUD. User-facing messages in Spanish.
 * `stripUnknown` (applied by the `validate` middleware) discards any field not
 * declared here → anti mass-assignment.
 */

const imageUrl = Joi.string().uri().max(500).messages({
  "string.uri": "La imagen debe ser una URL válida.",
  "string.max": "La URL de la imagen es demasiado larga.",
});

const images = Joi.object({
  thumbnail: imageUrl,
  banner: imageUrl,
});

const skuPrefix = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z]{2,8}$/)
  .messages({
    "string.pattern.base": "El prefijo SKU debe tener de 2 a 8 letras (A-Z).",
    "string.empty": "El prefijo SKU es obligatorio.",
    "any.required": "El prefijo SKU es obligatorio.",
  });

const name = Joi.string().trim().min(2).max(80).messages({
  "string.min": "El nombre debe tener al menos 2 caracteres.",
  "string.max": "El nombre es demasiado largo.",
  "string.empty": "El nombre es obligatorio.",
  "any.required": "El nombre es obligatorio.",
});

const createCategorySchema = Joi.object({
  name: name.required(),
  skuPrefix: skuPrefix.required(),
  description: Joi.string().trim().max(500).allow(""),
  images,
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0),
});

const updateCategorySchema = Joi.object({
  name,
  skuPrefix,
  description: Joi.string().trim().max(500).allow(""),
  images,
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0),
})
  .min(1)
  .messages({ "object.min": "Envía al menos un campo para actualizar." });

export { createCategorySchema, updateCategorySchema };
