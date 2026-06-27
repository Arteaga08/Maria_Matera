/**
 * Operational error with an HTTP status code. The global error handler uses
 * `isOperational` to distinguish expected errors (shown to the client) from
 * unexpected bugs (hidden behind a generic message in production).
 */

type ErrorStatus = "fail" | "error";

class AppError extends Error {
  readonly statusCode: number;
  readonly status: ErrorStatus;
  readonly isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode >= 400 && statusCode < 500 ? "fail" : "error";
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export type { ErrorStatus };
export { AppError };
