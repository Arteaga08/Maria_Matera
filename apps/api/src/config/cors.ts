import type { CorsOptions } from "cors";
import { env } from "./env.js";

/**
 * CORS whitelist. The same `allowedOrigins` list is reused by the
 * `verifyOrigin` middleware so both layers stay in sync.
 */

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header (server-to-server, health checks, curl)
    // are allowed here; route-level auth still applies.
    if (!origin || env.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origen no permitido por CORS"));
  },
  credentials: true,
};

export { corsOptions };
