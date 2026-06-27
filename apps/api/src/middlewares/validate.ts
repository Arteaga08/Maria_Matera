import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ObjectSchema } from "joi";
import { AppError } from "../utils/AppError.js";
import { deepSanitize } from "../utils/sanitize.js";

/**
 * Per-endpoint validation middleware factory. Validates the request body
 * against a Joi schema with `stripUnknown: true` (discards unexpected fields →
 * prevents mass assignment), then XSS-sanitizes the validated result. The
 * cleaned, typed payload replaces `req.body` for the controller to consume.
 *
 * Concrete, user-facing (Spanish) messages live in each schema under
 * `validators/`; this factory just surfaces them.
 */

const validate =
  (schema: ObjectSchema): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      stripUnknown: true,
      abortEarly: false,
      convert: true,
    });

    if (error) {
      const message = error.details.map((detail) => detail.message).join(". ");
      next(new AppError(message, 400));
      return;
    }

    req.body = deepSanitize(value);
    next();
  };

export { validate };
