import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import * as addresses from "../services/address.service.js";

/**
 * Address book controllers. Every operation is scoped to `req.auth.id` (the
 * authenticated customer) — never to an id from params/body — so a customer
 * can never read or mutate another customer's addresses.
 */

const list = asyncHandler(async (req, res) => {
  const items = await addresses.list(req.auth!.id);
  sendResponse({ res, message: "Direcciones.", data: { addresses: items } });
});

const create = asyncHandler(async (req, res) => {
  const address = await addresses.create(req.auth!.id, req.body);
  sendResponse({ res, statusCode: 201, message: "Dirección creada.", data: { address } });
});

const update = asyncHandler(async (req, res) => {
  const address = await addresses.update(req.auth!.id, req.params.addressId as string, req.body);
  sendResponse({ res, message: "Dirección actualizada.", data: { address } });
});

const remove = asyncHandler(async (req, res) => {
  await addresses.remove(req.auth!.id, req.params.addressId as string);
  sendResponse({ res, message: "Dirección eliminada.", data: null });
});

export { list, create, update, remove };
