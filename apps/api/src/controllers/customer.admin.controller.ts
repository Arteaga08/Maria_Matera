import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as crm from "../services/customer.admin.service.js";

/**
 * Admin CRM controllers. Reads (list/detail/stats) plus the audited tier
 * change. Role gating (Admin+Editor reads, Admin-only tier) lives in the
 * router, not here.
 */

const adminList = asyncHandler(async (req, res) => {
  const { items, meta } = await crm.adminList(req.query);
  sendResponse({ res, message: "Clientes.", data: { items }, meta });
});

const adminGet = asyncHandler(async (req, res) => {
  const detail = await crm.adminGetDetail(req.params.customerId as string);
  sendResponse({ res, message: "Cliente.", data: detail });
});

const changeTier = asyncHandler(async (req, res) => {
  const customer = await crm.changeTier(
    req.params.customerId as string,
    req.body.tier,
    getActor(req),
  );
  sendResponse({ res, message: "Nivel del cliente actualizado.", data: { customer } });
});

const adminStats = asyncHandler(async (req, res) => {
  const stats = await crm.adminStats({
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  sendResponse({ res, message: "Estadísticas de clientes.", data: { stats } });
});

export { adminList, adminGet, changeTier, adminStats };
