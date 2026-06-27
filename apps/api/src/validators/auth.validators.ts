import Joi from "joi";

/**
 * Joi schemas for the auth endpoints. Messages are user-facing → Spanish and
 * concrete. Used with the `validate` middleware (stripUnknown + sanitize).
 */

const email = Joi.string().email().lowercase().max(254).required().messages({
  "string.email": "El correo no tiene un formato válido.",
  "string.empty": "El correo es obligatorio.",
  "any.required": "El correo es obligatorio.",
  "string.max": "El correo es demasiado largo.",
});

const password = Joi.string()
  .min(10)
  .max(128)
  .pattern(/[a-zA-Z]/)
  .pattern(/\d/)
  .required()
  .messages({
    "string.min": "La contraseña debe tener al menos 10 caracteres.",
    "string.max": "La contraseña es demasiado larga.",
    "string.pattern.base": "La contraseña debe incluir letras y números.",
    "string.empty": "La contraseña es obligatoria.",
    "any.required": "La contraseña es obligatoria.",
  });

const token = Joi.string().hex().length(64).required().messages({
  "string.hex": "El token no es válido.",
  "string.length": "El token no es válido.",
  "any.required": "El token es obligatorio.",
});

const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required().messages({
    "string.min": "El nombre debe tener al menos 2 caracteres.",
    "string.max": "El nombre es demasiado largo.",
    "string.empty": "El nombre es obligatorio.",
    "any.required": "El nombre es obligatorio.",
  }),
  email,
  password,
  marketingConsent: Joi.boolean().default(false),
});

const loginSchema = Joi.object({
  email,
  password: Joi.string().required().messages({
    "string.empty": "La contraseña es obligatoria.",
    "any.required": "La contraseña es obligatoria.",
  }),
});

const verifyEmailSchema = Joi.object({ token });

const forgotPasswordSchema = Joi.object({ email });

const resetPasswordSchema = Joi.object({ token, password });

const adminLoginSchema = Joi.object({
  email,
  password: Joi.string().required().messages({
    "string.empty": "La contraseña es obligatoria.",
    "any.required": "La contraseña es obligatoria.",
  }),
});

export {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  adminLoginSchema,
};
