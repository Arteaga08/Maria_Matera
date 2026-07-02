import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as inventory from "../services/inventory.service.js";

/**
 * Inventory controller (admin). Absolute stock adjustment for a variant; the
 * change is audited by the service.
 */

const adjustStock = asyncHandler(async (req, res) => {
  const variant = await inventory.adjustStock(
    req.params.variantId as string,
    req.body.onHand,
    getActor(req),
  );
  sendResponse({ res, message: "Existencia actualizada.", data: { variant } });
});

export { adjustStock };
