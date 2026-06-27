import type { Response } from "express";
import type { PaginationMeta } from "@maria-matera/shared";

/**
 * Single, consistent success-response envelope for every endpoint.
 * Controllers never build the JSON by hand — they call `sendResponse`.
 * Errors are handled separately by the global error handler.
 */

interface SendResponseOptions<TData> {
  res: Response;
  statusCode?: number;
  message: string;
  data: TData;
  meta?: PaginationMeta;
}

const sendResponse = <TData>({
  res,
  statusCode = 200,
  message,
  data,
  meta,
}: SendResponseOptions<TData>): void => {
  res.status(statusCode).json({
    status: "success",
    message,
    data,
    ...(meta ? { meta } : {}),
  });
};

export { sendResponse };
