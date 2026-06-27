import type { NextFunction, Request, Response } from "express";
import { deepSanitize } from "../utils/sanitize.js";

/**
 * Global, defense-in-depth XSS guard: recursively escapes script/HTML payloads
 * in the request body before any handler runs. Per-endpoint Joi validation
 * (`validate`) is the primary input contract; this is the safety net.
 * Credential fields are preserved untouched (see `deepSanitize`).
 */

const sanitizeInput = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === "object") {
    req.body = deepSanitize(req.body);
  }
  next();
};

export { sanitizeInput };
