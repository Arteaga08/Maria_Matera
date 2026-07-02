import Joi from "joi";

/**
 * Joi schemas for collection admin CRUD (Spanish messages, stripUnknown).
 */

const mediaUrl = Joi.string().uri().max(500).messages({
  "string.uri": "El recurso debe ser una URL válida.",
  "string.max": "La URL es demasiado larga.",
});

const heroMedia = Joi.object({
  image: mediaUrl,
  video: mediaUrl,
});

const name = Joi.string().trim().min(2).max(100).messages({
  "string.min": "El nombre debe tener al menos 2 caracteres.",
  "string.max": "El nombre es demasiado largo.",
  "string.empty": "El nombre es obligatorio.",
  "any.required": "El nombre es obligatorio.",
});

const createCollectionSchema = Joi.object({
  name: name.required(),
  description: Joi.string().trim().max(1000).allow(""),
  heroMedia,
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0),
});

const updateCollectionSchema = Joi.object({
  name,
  description: Joi.string().trim().max(1000).allow(""),
  heroMedia,
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0),
})
  .min(1)
  .messages({ "object.min": "Envía al menos un campo para actualizar." });

export { createCollectionSchema, updateCollectionSchema };
