import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/**
 * Defense-in-depth against CSRF (the primary defense is the SameSite=strict
 * cookie). On state-changing methods, rejects requests whose Origin (or Referer
 * fallback) is not whitelisted. Requests without Origin/Referer (server-to-server,
 * CLI, health checks) are allowed; route-level auth still applies.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isAllowed = (value: string): boolean =>
  env.allowedOrigins.some((origin) => value === origin || value.startsWith(`${origin}/`));

const verifyOrigin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  const source = origin ?? referer;

  if (!source || isAllowed(source)) {
    next();
    return;
  }

  next(new AppError("Origen de la solicitud no permitido", 403));
};

export { verifyOrigin };
