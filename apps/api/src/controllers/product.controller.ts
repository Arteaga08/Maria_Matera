import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as products from "../services/product.service.js";

/**
 * Product controllers. Public catalog (filter/search/paginate) + admin CRUD.
 */

const listPublic = asyncHandler(async (req, res) => {
  const { items, meta } = await products.listPublic(req.query);
  sendResponse({ res, message: "Catálogo.", data: { products: items }, meta });
});

const getBySlug = asyncHandler(async (req, res) => {
  const { product, variants } = await products.getBySlugPublic(req.params.slug as string);
  sendResponse({ res, message: "Producto.", data: { product, variants } });
});

const adminList = asyncHandler(async (req, res) => {
  const { items, meta } = await products.adminList(req.query);
  sendResponse({ res, message: "Productos.", data: { products: items }, meta });
});

const adminGet = asyncHandler(async (req, res) => {
  const { product, variants } = await products.adminGet(req.params.id as string);
  sendResponse({ res, message: "Producto.", data: { product, variants } });
});

const create = asyncHandler(async (req, res) => {
  const { product, variants } = await products.create(req.body, getActor(req));
  sendResponse({ res, statusCode: 201, message: "Producto creado.", data: { product, variants } });
});

const update = asyncHandler(async (req, res) => {
  const product = await products.update(req.params.id as string, req.body, getActor(req));
  sendResponse({ res, message: "Producto actualizado.", data: { product } });
});

const setPublished = asyncHandler(async (req, res) => {
  const product = await products.setPublished(req.params.id as string, req.body.isPublished, getActor(req));
  sendResponse({
    res,
    message: product.isPublished ? "Producto publicado." : "Producto despublicado.",
    data: { product },
  });
});

const remove = asyncHandler(async (req, res) => {
  await products.archive(req.params.id as string, getActor(req));
  sendResponse({ res, message: "Producto archivado.", data: null });
});

export { listPublic, getBySlug, adminList, adminGet, create, update, setPublished, remove };
