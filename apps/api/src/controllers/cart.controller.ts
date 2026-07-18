import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import * as cartService from "../services/cart.service.js";

/**
 * Cart controllers. Every operation is scoped to `req.auth.id` (the
 * authenticated customer) — never to an id from params/body — so a customer
 * can never read or mutate another customer's cart. Every mutation responds
 * with the freshly re-priced cart so the client always renders live totals.
 */

const getCart = asyncHandler(async (req, res) => {
  const cart = await cartService.getPriced(req.auth!.id);
  sendResponse({ res, message: "Carrito.", data: { cart } });
});

const addItem = asyncHandler(async (req, res) => {
  await cartService.addItem(req.auth!.id, req.body);
  const cart = await cartService.getPriced(req.auth!.id);
  sendResponse({ res, statusCode: 201, message: "Artículo agregado al carrito.", data: { cart } });
});

const updateItem = asyncHandler(async (req, res) => {
  await cartService.updateQty(req.auth!.id, req.params.itemId as string, req.body.qty);
  const cart = await cartService.getPriced(req.auth!.id);
  sendResponse({ res, message: "Cantidad actualizada.", data: { cart } });
});

const removeItem = asyncHandler(async (req, res) => {
  await cartService.removeItem(req.auth!.id, req.params.itemId as string);
  const cart = await cartService.getPriced(req.auth!.id);
  sendResponse({ res, message: "Artículo eliminado del carrito.", data: { cart } });
});

const clearCart = asyncHandler(async (req, res) => {
  await cartService.clear(req.auth!.id);
  sendResponse({ res, message: "Carrito vaciado.", data: null });
});

export { getCart, addItem, updateItem, removeItem, clearCart };
