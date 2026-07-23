import * as Sentry from "@sentry/node";
import { env } from "./env.js";

/**
 * Sentry wrapper — the only module allowed to import `@sentry/node` directly
 * (same pattern as `media.service.ts` being the sole importer of `cloudinary`).
 * Every function is a no-op when `SENTRY_DSN` is unset, so the integration is
 * entirely optional in dev/test and never requires a real account to boot.
 * Error tracking only — no performance tracing (`tracesSampleRate: 0`).
 */

const isEnabled = env.sentryDsn !== "";

const initSentry = (): void => {
  if (!isEnabled) return;
  Sentry.init({ dsn: env.sentryDsn, environment: env.nodeEnv, tracesSampleRate: 0 });
};

const captureException = (error: unknown, context?: Record<string, unknown>): void => {
  if (!isEnabled) return;
  Sentry.captureException(error, context);
};

const flush = (timeoutMs = 2000): Promise<boolean> =>
  isEnabled ? Sentry.flush(timeoutMs) : Promise.resolve(true);

export { initSentry, captureException, flush };
