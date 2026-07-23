import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import * as auditService from "../services/audit.service.js";

/**
 * Global audit-log read (admin dashboard). Read-only by design — the trail is
 * append-only and no mutation endpoint will ever exist for it.
 */

const adminList = asyncHandler(async (req, res) => {
  const { items, meta } = await auditService.adminList(req.query);
  sendResponse({ res, message: "Auditoría.", data: { items }, meta });
});

export { adminList };
