import type { OrderStatus } from "@maria-matera/shared";
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
  const orders = await orderService.adminList({
    status: req.query.status as OrderStatus | undefined,
    customerId: req.query.customerId as string | undefined,
  });
  sendResponse({ res, message: "Órdenes.", data: { orders } });
});

const adminGet = asyncHandler(async (req, res) => {
  const order = await orderService.adminGet(req.params.orderId as string);
  sendResponse({ res, message: "Orden.", data: { order } });
});

const adminAdvance = asyncHandler(async (req, res) => {
  const order = await orderService.adminAdvance(
    req.params.orderId as string,
    req.body.status as OrderStatus,
    getActor(req).id,
    req.body.reason as string | undefined,
  );
  sendResponse({ res, message: "Estado de la orden actualizado.", data: { order } });
});

const adminRefund = asyncHandler(async (req, res) => {
  const order = await orderService.adminRefund(
    req.params.orderId as string,
    req.body.reason as string,
    getActor(req).id,
  );
  sendResponse({ res, message: "Orden reembolsada.", data: { order } });
});

export { create, list, get, adminList, adminGet, adminAdvance, adminRefund };
