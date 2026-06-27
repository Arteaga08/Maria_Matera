import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";
import { env } from "../config/env.js";

/**
 * Rate-limiter factory. Each sensitive action gets its own dedicated limiter
 * (login, checkout, payments, public reads). Outside production it is a no-op
 * so dev/tests are never throttled. Admin routes are intentionally NOT limited:
 * their guard is auth + role, not a rate cap.
 *
 * Note: the default MemoryStore does not share state across instances. For a
 * multi-instance deployment, swap in a shared store (Redis) here.
 */

interface RateLimiterConfig {
  windowMs: number;
  max: number;
  message: string;
}

const passthrough: RequestHandler = (_req, _res, next) => next();

const createRateLimiter = ({ windowMs, max, message }: RateLimiterConfig): RequestHandler => {
  if (!env.isProduction) {
    return passthrough;
  }
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { status: "fail", message },
  });
};

// Global backstop limiter (defense-in-depth). Per-action limiters are defined
// alongside their routers as those features land.
const globalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: "Demasiadas solicitudes. Intente de nuevo mas tarde.",
});

export type { RateLimiterConfig };
export { createRateLimiter, globalLimiter };
