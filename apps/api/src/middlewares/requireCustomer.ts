import type { NextFunction, Request, RequestHandler, Response } from "express";
import { UserType } from "@maria-matera/shared";
import { AppError } from "../utils/AppError.js";

/**
 * Authorization guard. Must run AFTER `protect`. Requires a customer
 * principal. Admins never pass — customers don't have sub-roles, so unlike
 * `restrictTo` there is no roles argument.
 */

const requireCustomer: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.auth) {
    next(new AppError("No autenticado", 401));
    return;
  }
  if (req.auth.userType !== UserType.Customer) {
    next(new AppError("No tienes permiso para realizar esta acción", 403));
    return;
  }
  next();
};

export { requireCustomer };
