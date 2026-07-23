import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import * as desireService from "../services/desire.service.js";

/**
 * Desire analysis controllers. `recordView` is the sole public handler —
 * always 202 (persisted or silently dropped, indistinguishable on purpose);
 * `desireStats` is the read-only admin analysis.
 */

const recordView = asyncHandler(async (req, res) => {
  await desireService.recordProductView(req.body.productId as string);
  sendResponse({ res, statusCode: 202, message: "Registrado.", data: null });
});

const desireStats = asyncHandler(async (req, res) => {
  const stats = await desireService.adminDesire(req.query as Record<string, string>);
  sendResponse({ res, message: "Análisis de deseo.", data: stats });
});

export { recordView, desireStats };
