import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { AppError } from "../../src/utils/AppError.js";

/**
 * Global error handler — only genuinely uncaught (>=500, non-operational)
 * errors get reported to Sentry. Expected 4xx `AppError`s must NOT be
 * reported, or every failed login/validation would burn Sentry quota with
 * noise instead of real incidents.
 */

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/sentry.js", () => ({
  captureException: captureExceptionMock,
}));

import { errorHandler } from "../../src/middlewares/errorHandler.js";

const makeRes = (): Response => {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as Response;
};

const makeReq = (): Request => ({ originalUrl: "/api/v1/test" }) as Request;

describe("errorHandler + Sentry reporting", () => {
  it("reports a non-operational 500 error to Sentry", () => {
    captureExceptionMock.mockClear();
    const error = new Error("unexpected boom");

    errorHandler(error, makeReq(), makeRes(), vi.fn());

    expect(captureExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ extra: expect.objectContaining({ path: "/api/v1/test" }) }),
    );
  });

  it("does NOT report an expected 4xx AppError to Sentry", () => {
    captureExceptionMock.mockClear();
    const error = new AppError("Correo o contraseña incorrectos.", 401);

    errorHandler(error, makeReq(), makeRes(), vi.fn());

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
