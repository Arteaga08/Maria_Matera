import helmet from "helmet";
import type { RequestHandler } from "express";
import { env } from "../config/env.js";

/**
 * Security headers for a pure JSON API. Helmet defaults are correct here; the
 * site-level CSP belongs in the Next.js frontend. HSTS is enabled only in
 * production (so it never interferes with plain-HTTP local development).
 */

const securityHeaders: RequestHandler = helmet({
  hsts: env.isProduction ? { maxAge: 15_552_000, includeSubDomains: true, preload: true } : false,
});

export { securityHeaders };
