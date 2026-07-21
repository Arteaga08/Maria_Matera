import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as shippingService from "../services/shipping.service.js";

/**
 * Shipping controllers (Milestone 7, Task 4). Thin HTTP layer over
 * `shipping.service.ts` — extraction + service call + response only, zero
 * business logic. Every admin handler tags the mutation with `getActor(req)`
 * (built from `req.auth`, set by `protect`); `track` is the sole public,
 * unauthenticated handler.
 */

const assignGuide = asyncHandler(async (req, res) => {
  const order = await shippingService.assignGuide(
    req.params.orderId as string,
    { carrier: req.body.carrier, trackingNumber: req.body.trackingNumber },
    getActor(req),
    req.body.reason as string | undefined,
  );
  sendResponse({ res, message: "Guía asignada. Se notificó al cliente.", data: { order } });
});

const deliver = asyncHandler(async (req, res) => {
  const order = await shippingService.markDelivered(
    req.params.orderId as string,
    getActor(req),
    req.body.reason as string | undefined,
  );
  sendResponse({ res, message: "Orden marcada como entregada.", data: { order } });
});

const editGuide = asyncHandler(async (req, res) => {
  const order = await shippingService.editGuide(
    req.params.orderId as string,
    { carrier: req.body.carrier, trackingNumber: req.body.trackingNumber },
    getActor(req),
    req.body.reason as string | undefined,
  );
  sendResponse({ res, message: "Guía corregida.", data: { order } });
});

const revert = asyncHandler(async (req, res) => {
  const order = await shippingService.revertShipment(
    req.params.orderId as string,
    req.body.reason as string,
    getActor(req),
  );
  sendResponse({ res, message: "Envío revertido a preparación.", data: { order } });
});

const processing = asyncHandler(async (req, res) => {
  const order = await shippingService.markProcessing(
    req.params.orderId as string,
    getActor(req),
    req.body.reason as string | undefined,
  );
  sendResponse({ res, message: "Orden marcada en preparación.", data: { order } });
});

const getShipment = asyncHandler(async (req, res) => {
  const { order, trackingUrl } = await shippingService.getShipment(req.params.orderId as string);
  sendResponse({ res, message: "Envío de la orden.", data: { order, trackingUrl } });
});

const track = asyncHandler(async (req, res) => {
  const tracking = await shippingService.publicTrack(req.params.trackingNumber as string);
  sendResponse({ res, message: "Información de rastreo.", data: { tracking } });
});

export { assignGuide, deliver, editGuide, revert, processing, getShipment, track };
