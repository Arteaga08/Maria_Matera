import Joi from "joi";
import { Currency } from "@maria-matera/shared";

/**
 * Joi schemas for product admin CRUD. `priceCents` is an integer (minor units).
 * `isPublished`, stock and SKU are NOT settable here (dedicated endpoints) →
 * anti mass-assignment via stripUnknown.
 */

const objectId = Joi.string().hex().length(24).messages({
  "string.hex": "Identificador inválido.",
  "string.length": "Identificador inválido.",
});

const imageUrl = Joi.string().uri().max(500);

const stone = Joi.object({
  type: Joi.string().trim().max(80).allow(""),
  carat: Joi.number().min(0),
});

const images = Joi.object({
  cardPrimary: imageUrl,
  cardHover: imageUrl,
  gallery: Joi.array().items(imageUrl).max(20),
});

const name = Joi.string().trim().min(2).max(160).messages({
  "string.min": "El nombre debe tener al menos 2 caracteres.",
  "string.max": "El nombre es demasiado largo.",
  "string.empty": "El nombre es obligatorio.",
  "any.required": "El nombre es obligatorio.",
});

const description = Joi.string().trim().min(10).max(5000).messages({
  "string.min": "La descripción debe tener al menos 10 caracteres.",
  "string.max": "La descripción es demasiado larga.",
  "string.empty": "La descripción es obligatoria.",
  "any.required": "La descripción es obligatoria.",
});

const priceCents = Joi.number().integer().min(0).messages({
  "number.base": "El precio debe ser un número (en centavos).",
  "number.min": "El precio no puede ser negativo.",
  "any.required": "El precio es obligatorio.",
});

const createProductSchema = Joi.object({
  name: name.required(),
  description: description.required(),
  categoryId: objectId.required(),
  collectionId: objectId,
  priceCents: priceCents.required(),
  currency: Joi.string().valid(...Object.values(Currency)),
  material: Joi.string().trim().max(80).allow(""),
  stone,
  images,
  isVipExclusive: Joi.boolean(),
  releaseAt: Joi.date().iso(),
});

const updateProductSchema = Joi.object({
  name,
  description,
  categoryId: objectId,
  collectionId: objectId,
  priceCents,
  currency: Joi.string().valid(...Object.values(Currency)),
  material: Joi.string().trim().max(80).allow(""),
  stone,
  images,
  isVipExclusive: Joi.boolean(),
  releaseAt: Joi.date().iso(),
})
  .min(1)
  .messages({ "object.min": "Envía al menos un campo para actualizar." });

const publishProductSchema = Joi.object({
  isPublished: Joi.boolean().required().messages({
    "any.required": "Indica si el producto debe publicarse.",
  }),
});

export { createProductSchema, updateProductSchema, publishProductSchema };
