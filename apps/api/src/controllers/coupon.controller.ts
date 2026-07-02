import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as coupons from "../services/coupon.service.js";

/**
 * Coupon controllers. Admin CRUD + a public validation/preview endpoint.
 */

const adminList = asyncHandler(async (_req, res) => {
  const items = await coupons.adminList();
  sendResponse({ res, message: "Cupones.", data: { coupons: items } });
});

const adminGet = asyncHandler(async (req, res) => {
  const coupon = await coupons.adminGet(req.params.id as string);
  sendResponse({ res, message: "Cupón.", data: { coupon } });
});

const create = asyncHandler(async (req, res) => {
  const coupon = await coupons.create(req.body, getActor(req));
  sendResponse({ res, statusCode: 201, message: "Cupón creado.", data: { coupon } });
});

const update = asyncHandler(async (req, res) => {
  const coupon = await coupons.update(req.params.id as string, req.body, getActor(req));
  sendResponse({ res, message: "Cupón actualizado.", data: { coupon } });
});

const remove = asyncHandler(async (req, res) => {
  await coupons.remove(req.params.id as string, getActor(req));
  sendResponse({ res, message: "Cupón archivado.", data: null });
});

const validatePublic = asyncHandler(async (req, res) => {
  const preview = await coupons.validateForPreview(req.body.code, req.body.subtotalCents);
  sendResponse({ res, message: "Cupón válido.", data: { coupon: preview } });
});

export { adminList, adminGet, create, update, remove, validatePublic };
