import type { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/AppError.js";

/**
 * Catches any request that did not match a route and forwards a 404 to the
 * global error handler.
 */

const notFound = (req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(`Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404));
};

export { notFound };
