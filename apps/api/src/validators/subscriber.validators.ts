import Joi from "joi";

/**
 * Joi schema for newsletter subscription (double opt-in).
 */

const subscribeSchema = Joi.object({
  email: Joi.string().email().lowercase().max(254).required().messages({
    "string.email": "El correo no tiene un formato válido.",
    "string.empty": "El correo es obligatorio.",
    "any.required": "El correo es obligatorio.",
  }),
  consent: Joi.boolean(),
});

export { subscribeSchema };
