import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * MongoDB connection helpers. `connectDatabase` is called once at boot and
 * fails fast if the database is unreachable. `disconnectDatabase` is used by
 * the graceful shutdown handler.
 */

// Hardening: block unknown query operators from being silently cast.
mongoose.set("strictQuery", true);

const connectDatabase = async (): Promise<void> => {
  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 10_000,
    });
    logger.info("MongoDB conectado");
  } catch (error) {
    logger.error({ err: error }, "No se pudo conectar a MongoDB");
    throw error;
  }
};

const disconnectDatabase = async (): Promise<void> => {
  await mongoose.connection.close();
  logger.info("MongoDB desconectado");
};

export { connectDatabase, disconnectDatabase };
