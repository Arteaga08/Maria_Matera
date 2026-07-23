import Joi from "joi";
import { AnnouncementType, HeroMediaType } from "@maria-matera/shared";

/**
 * Joi schemas for the home content editor (per-section PUTs). Links (`ctaHref`
 * / announcement `href`) accept either an https URL or a storefront-relative
 * path ("/coleccion/x") — anything else (http, javascript:, ...) is rejected.
 * A hero CTA must be complete or absent (`.and("ctaLabel", "ctaHref")`).
 */

const objectId = Joi.string().hex().length(24).messages({
  "string.hex": "El identificador de producto no es válido.",
  "string.length": "El identificador de producto no es válido.",
});

const safeLink = Joi.alternatives()
  .try(
    Joi.string().uri({ scheme: ["https"] }),
    Joi.string().pattern(/^\/[^\s]*$/),
  )
  .messages({
    "alternatives.match": "El enlace debe ser una URL https o una ruta interna (/...).",
  });

const slideSchema = Joi.object({
  mediaType: Joi.string()
    .valid(...Object.values(HeroMediaType))
    .required()
    .messages({
      "any.only": "El tipo de medio debe ser imagen o video.",
      "any.required": "El tipo de medio es obligatorio.",
    }),
  mediaUrl: Joi.string()
    .uri({ scheme: ["https"] })
    .required()
    .messages({
      "string.uri": "La URL del medio debe ser https.",
      "string.uriCustomScheme": "La URL del medio debe ser https.",
      "any.required": "La URL del medio es obligatoria.",
    }),
  title: Joi.string().trim().max(160).messages({
    "string.max": "El título no puede exceder 160 caracteres.",
  }),
  subtitle: Joi.string().trim().max(160).messages({
    "string.max": "El subtítulo no puede exceder 160 caracteres.",
  }),
  ctaLabel: Joi.string().trim().max(60).messages({
    "string.max": "El texto del botón no puede exceder 60 caracteres.",
  }),
  ctaHref: safeLink,
  isActive: Joi.boolean().default(true),
})
  .and("ctaLabel", "ctaHref")
  .messages({
    "object.and": "El botón del slide necesita texto y enlace (o ninguno de los dos).",
  });

const heroSchema = Joi.object({
  slides: Joi.array().items(slideSchema).max(8).required().messages({
    "array.max": "El hero admite máximo 8 slides.",
    "any.required": "La lista de slides es obligatoria.",
  }),
});

const curatedSectionSchema = Joi.object({
  productIds: Joi.array().items(objectId).unique().max(12).required().messages({
    "array.unique": "Hay productos repetidos en la selección.",
    "array.max": "La sección admite máximo 12 productos.",
    "any.required": "La lista de productos es obligatoria.",
  }),
  isActive: Joi.boolean().default(true),
});

const announcementSchema = Joi.object({
  text: Joi.string().trim().min(1).max(200).required().messages({
    "string.empty": "El texto del anuncio es obligatorio.",
    "string.max": "El anuncio no puede exceder 200 caracteres.",
    "any.required": "El texto del anuncio es obligatorio.",
  }),
  href: safeLink,
  type: Joi.string()
    .valid(...Object.values(AnnouncementType))
    .required()
    .messages({
      "any.only": "El tipo de anuncio debe ser barra o pop-up.",
      "any.required": "El tipo de anuncio es obligatorio.",
    }),
  isActive: Joi.boolean().required().messages({
    "any.required": "Debes indicar si el anuncio está activo.",
  }),
});

export { heroSchema, curatedSectionSchema, announcementSchema };
