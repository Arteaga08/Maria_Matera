import type { Server } from "node:http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase } from "./config/db.js";
import { initSentry, captureException, flush as flushSentry } from "./config/sentry.js";
import { buildApp } from "./app.js";
import * as orderService from "./services/order.service.js";

initSentry();

// Reconciliation sweep interval. Every 5 min comfortably beats the 15-min
// reservation TTL, so a lost/delayed `payment_intent.succeeded` webhook is
// caught (order marked paid) — or an abandoned checkout cancelled — within one
// cycle of expiry, without hammering Stripe.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Process bootstrap: load env (already validated on import), connect to
 * MongoDB, start the HTTP server, and wire graceful shutdown so in-flight
 * requests drain and the DB connection closes cleanly.
 */

const start = async (): Promise<void> => {
  await connectDatabase();

  const app = buildApp();
  const server: Server = app.listen(env.port, () => {
    logger.info(`API escuchando en el puerto ${env.port} (${env.nodeEnv})`);
  });

  // Backstop for lost/delayed payment webhooks. No-op in the test suite (guarded
  // like `createRateLimiter`) so it never interferes with mongodb-memory-server
  // timing; runs in dev + production. `.unref()` so it never blocks shutdown.
  if (env.nodeEnv !== "test") {
    setInterval(() => {
      void orderService.reconcilePendingOrders().catch((error: unknown) => {
        logger.error({ err: error }, "Fallo en la reconciliación de órdenes pendientes.");
        captureException(error, { tags: { job: "reconcilePendingOrders" } });
      });
    }, RECONCILE_INTERVAL_MS).unref();
  }

  const shutdown = (signal: string): void => {
    logger.info(`Recibida senal ${signal}, cerrando...`);
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    // Safety net: force-exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled rejection");
  captureException(reason);
  // Flush before exiting: Sentry sends events asynchronously, and the process
  // would otherwise die before the event reaches Sentry's servers.
  void flushSentry().finally(() => process.exit(1));
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception");
  captureException(error);
  void flushSentry().finally(() => process.exit(1));
});

start().catch((error: unknown) => {
  logger.error({ err: error }, "Fallo al iniciar la API");
  captureException(error, { tags: { phase: "startup" } });
  void flushSentry().finally(() => process.exit(1));
});
