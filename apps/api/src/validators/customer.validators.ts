import Joi from "joi";
import { CustomerTier } from "@maria-matera/shared";

/**
 * Joi schemas for the admin CRM. The tier change is the only CRM mutation:
 * a single constrained enum field.
 */

const changeTierSchema = Joi.object({
  tier: Joi.string()
    .valid(...Object.values(CustomerTier))
    .required()
    .messages({
      "any.only": "El nivel indicado no es válido.",
      "any.required": "El nivel es obligatorio.",
      "string.empty": "El nivel es obligatorio.",
    }),
});

export { changeTierSchema };
