import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import * as overviewService from "../services/overview.service.js";

/**
 * Overview controller: thin HTTP layer over `overview.service.ts` — range
 * strings in, composed stats out.
 */

const adminOverview = asyncHandler(async (req, res) => {
  const stats = await overviewService.adminOverview({
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  sendResponse({ res, message: "Resumen del panel.", data: { stats } });
});

export { adminOverview };
