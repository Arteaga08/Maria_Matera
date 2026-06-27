import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so rejected promises are forwarded to the
 * global error handler instead of crashing the process. Removes the repeated
 * try/catch from every controller.
 */

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

const asyncHandler =
  (handler: AsyncRouteHandler): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };

export { asyncHandler };
