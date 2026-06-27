import { pino } from "pino";
import { env } from "./env.js";

/**
 * Structured logger (pino). Never log PII or secrets: sensitive fields are
 * redacted. `debug` is silenced outside development.
 */

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.token",
  "*.jwt",
  "*.cardNumber",
];

const isTest = env.nodeEnv === "test";

const logger = pino({
  level: isTest ? "silent" : env.isProduction ? "info" : "debug",
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  transport:
    env.isProduction || isTest
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

export { logger };
