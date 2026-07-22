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

const adminList = asyncHandler(async (req, res) => {
  const { items, meta } = await inventory.adminList(req.query);
  sendResponse({ res, message: "Inventario.", data: { items }, meta });
});

const adminStats = asyncHandler(async (_req, res) => {
  const stats = await inventory.adminStats();
  sendResponse({ res, message: "Estadísticas de inventario.", data: { stats } });
});

export { adjustStock, adminList, adminStats };
