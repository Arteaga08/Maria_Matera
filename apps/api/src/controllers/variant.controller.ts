import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as variants from "../services/variant.service.js";

/**
 * Variant controllers (admin). SKU is auto-generated; stock is handled by the
 * inventory endpoint.
 */

const add = asyncHandler(async (req, res) => {
  const variant = await variants.addVariant(req.params.id as string, req.body, getActor(req));
  sendResponse({ res, statusCode: 201, message: "Variante creada.", data: { variant } });
});

const update = asyncHandler(async (req, res) => {
  const variant = await variants.updateVariant(req.params.variantId as string, req.body, getActor(req));
  sendResponse({ res, message: "Variante actualizada.", data: { variant } });
});

const remove = asyncHandler(async (req, res) => {
  await variants.archiveVariant(req.params.variantId as string, getActor(req));
  sendResponse({ res, message: "Variante archivada.", data: null });
});

export { add, update, remove };
