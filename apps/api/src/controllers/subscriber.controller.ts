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
  const result = await subscribers.broadcastCoupon(req.params.couponId as string, getActor(req));
  sendResponse({ res, message: "Cupón enviado a los suscriptores.", data: result });
});

export { subscribe, confirm, unsubscribe, broadcast };
