import Joi from "joi";
import { Carrier } from "@maria-matera/shared";

/**
 * Joi schemas for shipping admin mutations. `carrier`/`trackingNumber` share
 * the same field-level validation across assign/edit; `editGuideSchema` uses
 * `.or("carrier", "trackingNumber")` — NOT a `.min(1)` on the whole object —
 * so an empty body or a `reason`-only body is rejected, but the presence of
 * `reason` alone can never satisfy the "at least one shipping field changed"
 * rule. This closes the phantom-audit-entry gap flagged in Task 3's review:
 * without it, `editGuide` could be called with no real change and still write
 * a no-op audit entry.
 */

const carrier = Joi.string()
  .valid(...Object.values(Carrier))
  .messages({
    "any.only": "El paquetero indicado no es válido.",
    "string.empty": "El paquetero es obligatorio.",
    "any.required": "El paquetero es obligatorio.",
  });

const trackingNumber = Joi.string().trim().min(4).max(60).messages({
  "string.min": "El número de guía no es válido.",
  "string.max": "El número de guía no es válido.",
  "string.empty": "El número de guía es obligatorio.",
  "any.required": "El número de guía es obligatorio.",
});

const reason = Joi.string().trim().max(300).messages({
  "string.max": "El motivo no puede exceder 300 caracteres.",
});

const assignGuideSchema = Joi.object({
  carrier: carrier.required(),
  trackingNumber: trackingNumber.required(),
  reason: reason.optional(),
});

const editGuideSchema = Joi.object({
  carrier: carrier.optional(),
  trackingNumber: trackingNumber.optional(),
  reason: reason.optional(),
})
  .or("carrier", "trackingNumber")
  .messages({
    "object.missing": "Debes indicar al menos un campo a corregir (paquetero o número de guía).",
  });

const revertShipmentSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(300).required().messages({
    "string.empty": "El motivo es obligatorio.",
    "string.min": "El motivo es demasiado corto.",
    "string.max": "El motivo no puede exceder 300 caracteres.",
    "any.required": "El motivo es obligatorio.",
  }),
});

const deliverSchema = Joi.object({
  reason: reason.optional(),
});

const processingSchema = Joi.object({
  reason: reason.optional(),
});

export {
  assignGuideSchema,
  editGuideSchema,
  revertShipmentSchema,
  deliverSchema,
  processingSchema,
};
