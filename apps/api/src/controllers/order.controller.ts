import { OrderStatus } from "@maria-matera/shared";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as orderService from "../services/order.service.js";

/**
 * Order controllers. Owner endpoints are scoped to `req.auth.id` (the
 * authenticated customer) — never an id from params/body — so a customer can
 * never read another customer's order. Admin endpoints drive status transitions
 * and refunds, tagging each history entry with the acting admin's id.
 */

// --- Owner-facing ------------------------------------------------------------

const create = asyncHandler(async (req, res) => {
  const { order, clientSecret } = await orderService.createOrder(req.auth!.id, req.body);
  // `clientSecret` lets the browser payment SDK confirm the PaymentIntent.
  sendResponse({ res, statusCode: 201, message: "Orden creada.", data: { order, clientSecret } });
});

const list = asyncHandler(async (req, res) => {
  const orders = await orderService.listMine(req.auth!.id);
  sendResponse({ res, message: "Órdenes.", data: { orders } });
});

const get = asyncHandler(async (req, res) => {
  const order = await orderService.getMine(req.auth!.id, req.params.orderId as string);
  sendResponse({ res, message: "Orden.", data: { order } });
});

// --- Admin-facing ------------------------------------------------------------

const adminList = asyncHandler(async (req, res) => {
  const { items, meta } = await orderService.adminList(req.query);
  sendResponse({ res, message: "Órdenes.", data: { orders: items }, meta });
});

const adminGet = asyncHandler(async (req, res) => {
  const detail = await orderService.adminGetDetail(req.params.orderId as string);
  sendResponse({ res, message: "Orden.", data: detail });
});

const adminStats = asyncHandler(async (req, res) => {
  const stats = await orderService.adminStats({
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  sendResponse({ res, message: "Estadísticas de órdenes.", data: { stats } });
});

const adminAdvance = asyncHandler(async (req, res) => {
  const to = req.body.status as OrderStatus;
  // Any transition INTO `processing` clears the shipping subdocument. This is a
  // no-op for the normal `paid → processing` start (shipping is still empty),
  // and the necessary cleanup for the `shipped → processing` revert branch: it
  // wipes the now-stale carrier/trackingNumber/shippedAt of the undone shipment
  // (including the sparse-indexed trackingNumber). Unconditional by target
  // status, so no extra DB lookup of the current status is needed.
  const shippingPatch = to === OrderStatus.Processing ? null : undefined;
  const order = await orderService.adminAdvance(
    req.params.orderId as string,
    to,
    getActor(req),
    req.body.reason as string | undefined,
    shippingPatch,
  );
  sendResponse({ res, message: "Estado de la orden actualizado.", data: { order } });
});

const adminRefund = asyncHandler(async (req, res) => {
  const order = await orderService.adminRefund(
    req.params.orderId as string,
    req.body.reason as string,
    getActor(req),
  );
  sendResponse({ res, message: "Orden reembolsada.", data: { order } });
});

export { create, list, get, adminList, adminGet, adminStats, adminAdvance, adminRefund };
