import { logger } from "../config/logger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import { AppError } from "../utils/AppError.js";
import * as subscribers from "../services/subscriber.service.js";

/**
 * Newsletter controllers. Public subscribe/confirm/unsubscribe + admin coupon
 * broadcast. Confirm/unsubscribe use GET (email links); the token comes from the
 * query string.
 */

const readToken = (value: unknown): string => {
  if (typeof value !== "string" || !value) {
    throw new AppError("Falta el token.", 400);
  }
  return value;
};

const subscribe = asyncHandler(async (req, res) => {
  await subscribers.subscribe(req.body.email, req.body.consent);
  sendResponse({
    res,
    statusCode: 202,
    message: "Revisa tu correo para confirmar tu suscripción.",
    data: null,
  });
});

const confirm = asyncHandler(async (req, res) => {
  await subscribers.confirm(readToken(req.query.token));
  sendResponse({ res, message: "Suscripción confirmada. ¡Gracias!", data: null });
});

const unsubscribe = asyncHandler(async (req, res) => {
  await subscribers.unsubscribe(readToken(req.query.token));
  sendResponse({ res, message: "Te diste de baja. No recibirás más correos.", data: null });
});

const broadcast = asyncHandler(async (req, res) => {
  const couponId = req.params.couponId as string;
  const actor = getActor(req);
  // The couponId is the request's primary input, so it's validated
  // synchronously — an unknown id still 404s like any other lookup. Only the
  // actual mass-send (below) is fire-and-forget: it acknowledges the admin
  // immediately instead of blocking on however many subscribers are on the
  // list (mirrors the `paid`-order despachador's pattern in
  // `order.notifications.ts`). A failure there is only logged — the request
  // has already been answered.
  const coupon = await subscribers.getCouponForBroadcast(couponId);
  void subscribers.broadcastCoupon(coupon, actor).catch((error: unknown) => {
    logger.error({ err: error, couponId }, "Fallo el envío en segundo plano del cupón.");
  });
  sendResponse({
    res,
    statusCode: 202,
    message: "El envío se está procesando en segundo plano.",
    data: null,
  });
});

export { subscribe, confirm, unsubscribe, broadcast };
