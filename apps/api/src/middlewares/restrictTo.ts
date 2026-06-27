import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type AdminRole, UserType } from "@maria-matera/shared";
import { AppError } from "../utils/AppError.js";

/**
 * Authorization guard. Must run AFTER `protect`. Requires an admin principal and
 * (optionally) one of the allowed roles. Customers never pass.
 */

const restrictTo =
  (...roles: AdminRole[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(new AppError("No autenticado", 401));
      return;
    }
    if (req.auth.userType !== UserType.Admin) {
      next(new AppError("No tienes permiso para realizar esta acción", 403));
      return;
    }
    if (roles.length > 0 && (!req.auth.role || !roles.includes(req.auth.role))) {
      next(new AppError("No tienes permiso para realizar esta acción", 403));
      return;
    }
    next();
  };

export { restrictTo };
