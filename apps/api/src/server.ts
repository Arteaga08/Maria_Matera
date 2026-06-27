import type { Server } from "node:http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase } from "./config/db.js";
import { buildApp } from "./app.js";

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
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception");
  process.exit(1);
});

start().catch((error: unknown) => {
  logger.error({ err: error }, "Fallo al iniciar la API");
  process.exit(1);
});
