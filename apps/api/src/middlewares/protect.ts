import type { NextFunction, Request, Response } from "express";
import { ACCESS_COOKIE } from "../utils/cookies.js";
import { verifyAccessToken } from "../utils/token.js";
import { AppError } from "../utils/AppError.js";

/**
 * Authentication guard. Verifies the access token from its HttpOnly cookie and
 * attaches the principal to `req.auth`. Deny-by-default: any missing/invalid
 * token results in 401.
 */

const protect = (req: Request, _res: Response, next: NextFunction): void => {
  const token = (req.cookies as Record<string, string | undefined>)?.[ACCESS_COOKIE];
  if (!token) {
    next(new AppError("No autenticado", 401));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = { id: payload.sub, userType: payload.userType, role: payload.role };
    next();
  } catch {
    next(new AppError("Sesión inválida o expirada", 401));
  }
};

export { protect };
