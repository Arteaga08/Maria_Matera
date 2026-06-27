import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AppError } from "../utils/AppError.js";

/**
 * Global error handler (4 args). Normalizes known errors (Mongoose, JWT) into
 * an operational shape. In production it returns only `{ status, message }` and
 * hides internals behind a generic message for non-operational errors; in
 * development it adds the stack. Never logs PII or secrets.
 */

interface NormalizedError {
  statusCode: number;
  message: string;
  isOperational: boolean;
}

const hasName = (error: unknown, name: string): boolean =>
  typeof error === "object" && error !== null && (error as { name?: string }).name === name;

const getCode = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null
    ? (error as { code?: number }).code
    : undefined;

const normalizeError = (error: unknown): NormalizedError => {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, message: error.message, isOperational: error.isOperational };
  }
  if (hasName(error, "CastError")) {
    return { statusCode: 400, message: "Identificador con formato invalido", isOperational: true };
  }
  if (hasName(error, "ValidationError")) {
    return { statusCode: 400, message: "Datos de entrada invalidos", isOperational: true };
  }
  if (getCode(error) === 11000) {
    return { statusCode: 409, message: "El recurso ya existe", isOperational: true };
  }
  if (hasName(error, "JsonWebTokenError") || hasName(error, "TokenExpiredError")) {
    return { statusCode: 401, message: "Sesion invalida o expirada", isOperational: true };
  }
  return { statusCode: 500, message: "Algo salio mal", isOperational: false };
};

const errorHandler = (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const normalized = normalizeError(error);

  if (normalized.statusCode >= 500) {
    logger.error({ err: error, path: req.originalUrl }, "Error no controlado");
  } else {
    logger.warn({ path: req.originalUrl, statusCode: normalized.statusCode }, normalized.message);
  }

  const body: Record<string, unknown> = {
    status: normalized.statusCode >= 500 ? "error" : "fail",
    message: normalized.message,
  };

  if (!env.isProduction && error instanceof Error) {
    body.stack = error.stack;
  }

  res.status(normalized.statusCode).json(body);
};

export { errorHandler };
