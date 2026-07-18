import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Fail-fast environment loader.
 * Loads `.env.<NODE_ENV>.local`, validates every required variable and exposes
 * a frozen, typed `env` object. Any missing/invalid value aborts the process
 * with a clear message — the app must never boot half-configured.
 */

const VALID_NODE_ENVS = ["development", "production", "test"] as const;
type NodeEnv = (typeof VALID_NODE_ENVS)[number];

const MIN_SECRET_LENGTH = 32;

interface Env {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  mongoUri: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  encryptionKey: string;
  accessTokenTtlMin: number;
  refreshTokenTtlDays: number;
  appUrl: string;
  allowedOrigins: string[];
  cloudinary: { cloudName: string; apiKey: string; apiSecret: string };
  email: { user: string; pass: string; from: string };
  telegram: { botToken: string; chatId: string };
  stripeSecretKey: string;
  stripeWebhookSecret: string;
}

const fail = (message: string): never => {
  // Use stderr directly: the logger may depend on env that is not yet loaded.
  process.stderr.write(`\n[env] Configuracion invalida: ${message}\n\n`);
  process.exit(1);
};

const resolveNodeEnv = (): NodeEnv => {
  const raw = process.env.NODE_ENV ?? "development";
  if (!VALID_NODE_ENVS.includes(raw as NodeEnv)) {
    return fail(`NODE_ENV="${raw}" no es valido. Use uno de: ${VALID_NODE_ENVS.join(", ")}.`);
  }
  return raw as NodeEnv;
};

const loadEnvFile = (nodeEnv: NodeEnv): void => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  // src/config -> apps/api
  const apiRoot = path.resolve(dirname, "..", "..");
  const envFile = path.join(apiRoot, `.env.${nodeEnv}.local`);
  if (existsSync(envFile)) {
    dotenv.config({ path: envFile });
  } else if (nodeEnv === "development") {
    process.stderr.write(`[env] Aviso: no se encontro ${envFile}; usando variables del proceso.\n`);
  }
};

const required = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") {
    return fail(`Falta la variable requerida ${key}.`);
  }
  return value.trim();
};

const requiredSecret = (key: string): string => {
  const value = required(key);
  if (value.length < MIN_SECRET_LENGTH) {
    fail(`${key} debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`);
  }
  return value;
};

const optionalInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fail(`${key}="${raw}" debe ser un entero positivo.`);
  }
  return parsed;
};

const parsePort = (raw: string): number => {
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return fail(`PORT="${raw}" no es un puerto valido.`);
  }
  return port;
};

const parseOrigins = (raw: string): string[] => {
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    return fail("CLIENT_URL no contiene ningun origen valido.");
  }
  return origins;
};

const loadEnv = (): Env => {
  const nodeEnv = resolveNodeEnv();
  loadEnvFile(nodeEnv);

  const jwtAccessSecret = requiredSecret("JWT_ACCESS_SECRET");
  const jwtRefreshSecret = requiredSecret("JWT_REFRESH_SECRET");
  if (jwtAccessSecret === jwtRefreshSecret) {
    fail("JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser distintos.");
  }

  const allowedOrigins = parseOrigins(required("CLIENT_URL"));

  const env: Env = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: parsePort(process.env.PORT ?? "4000"),
    mongoUri: required("MONGO_URI"),
    jwtAccessSecret,
    jwtRefreshSecret,
    encryptionKey: requiredSecret("ENCRYPTION_KEY"),
    accessTokenTtlMin: optionalInt("ACCESS_TOKEN_TTL_MIN", 15),
    refreshTokenTtlDays: optionalInt("REFRESH_TOKEN_TTL_DAYS", 7),
    appUrl: process.env.APP_URL?.trim() || allowedOrigins[0]!,
    allowedOrigins,
    cloudinary: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME?.trim() ?? "",
      apiKey: process.env.CLOUDINARY_API_KEY?.trim() ?? "",
      apiSecret: process.env.CLOUDINARY_API_SECRET?.trim() ?? "",
    },
    email: {
      user: process.env.EMAIL_USER?.trim() ?? "",
      pass: process.env.EMAIL_PASS?.trim() ?? "",
      from: process.env.EMAIL_FROM?.trim() ?? "",
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
      chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
    },
    stripeSecretKey: required("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
  };

  return Object.freeze(env);
};

const env = loadEnv();

export type { Env, NodeEnv };
export { env };
