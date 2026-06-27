import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { corsOptions } from "./config/cors.js";
import { mongoSanitize } from "./middlewares/mongoSanitize.js";
import { sanitizeInput } from "./middlewares/sanitizeInput.js";
import { verifyOrigin } from "./middlewares/verifyOrigin.js";
import { globalLimiter } from "./middlewares/rateLimit.js";
import { securityHeaders } from "./middlewares/securityHeaders.js";
import { notFound } from "./middlewares/notFound.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { apiRouter } from "./routes/index.js";

/**
 * Builds and configures the Express application. Kept separate from `server.ts`
 * (bootstrap) so the app can be imported by tests without opening a port.
 *
 * Middleware order is intentional and security-sensitive:
 *   helmet -> cors -> json(limit) -> cookieParser -> mongoSanitize ->
 *   sanitizeInput (XSS) -> verifyOrigin -> rateLimit -> routers ->
 *   notFound -> errorHandler
 */

const buildApp = (): Express => {
  const app = express();

  // Behind a reverse proxy in production (correct client IP for rate limiting
  // and `secure` cookies).
  if (env.isProduction) {
    app.set("trust proxy", 1);
  }

  app.use(pinoHttp({ logger }));
  app.use(securityHeaders);
  app.use(cors(corsOptions));

  // NOTE: payment webhooks (Stripe/Mercado Pago) need the RAW body and must be
  // mounted BEFORE express.json() when that feature lands.

  app.use(express.json({ limit: "10kb" }));
  app.use(cookieParser());
  app.use(mongoSanitize);
  app.use(sanitizeInput);
  app.use(verifyOrigin);
  app.use(globalLimiter);

  app.use("/api/v1", apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};

export { buildApp };
