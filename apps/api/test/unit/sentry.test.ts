import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `config/sentry.ts` wrapper — the only module in this codebase allowed to
 * import `@sentry/node` directly (mirrors how `media.service.ts` is the only
 * one importing `cloudinary`). Every function is a no-op when `SENTRY_DSN` is
 * unset (dev/test), so the integration never requires a real account.
 */

const sentryInitMock = vi.hoisted(() => vi.fn());
const sentryCaptureExceptionMock = vi.hoisted(() => vi.fn());
const sentryFlushMock = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", () => ({
  init: sentryInitMock,
  captureException: sentryCaptureExceptionMock,
  flush: sentryFlushMock,
}));

describe("config/sentry — disabled (no SENTRY_DSN)", () => {
  beforeEach(() => {
    vi.resetModules();
    sentryInitMock.mockReset();
    sentryCaptureExceptionMock.mockReset();
    sentryFlushMock.mockReset();
  });

  it("never calls the underlying SDK", async () => {
    vi.doMock("../../src/config/env.js", () => ({
      env: { sentryDsn: "", nodeEnv: "test" },
    }));
    const { initSentry, captureException, flush } = await import("../../src/config/sentry.js");

    initSentry();
    captureException(new Error("boom"));
    const result = await flush();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(sentryCaptureExceptionMock).not.toHaveBeenCalled();
    expect(sentryFlushMock).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe("config/sentry — enabled (SENTRY_DSN set)", () => {
  beforeEach(() => {
    vi.resetModules();
    sentryInitMock.mockReset();
    sentryCaptureExceptionMock.mockReset();
    sentryFlushMock.mockReset();
  });

  it("initializes with dsn/environment/tracesSampleRate:0 and forwards captures/flush", async () => {
    vi.doMock("../../src/config/env.js", () => ({
      env: { sentryDsn: "https://fake@sentry.io/1", nodeEnv: "production" },
    }));
    sentryFlushMock.mockResolvedValue(true);
    const { initSentry, captureException, flush } = await import("../../src/config/sentry.js");

    initSentry();
    expect(sentryInitMock).toHaveBeenCalledWith({
      dsn: "https://fake@sentry.io/1",
      environment: "production",
      tracesSampleRate: 0,
    });

    const error = new Error("boom");
    captureException(error, { tags: { job: "test" } });
    expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(error, { tags: { job: "test" } });

    const result = await flush(5000);
    expect(sentryFlushMock).toHaveBeenCalledWith(5000);
    expect(result).toBe(true);
  });
});
