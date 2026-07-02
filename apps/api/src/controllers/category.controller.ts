import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as categories from "../services/category.service.js";

/**
 * Category controllers. Public reads (active categories) + admin CRUD.
 */

const listPublic = asyncHandler(async (_req, res) => {
  const items = await categories.listPublic();
  sendResponse({ res, message: "Categorías activas.", data: { categories: items } });
});

const getBySlug = asyncHandler(async (req, res) => {
  const category = await categories.getBySlug(req.params.slug as string);
  sendResponse({ res, message: "Categoría.", data: { category } });
});

const adminList = asyncHandler(async (_req, res) => {
  const items = await categories.adminList();
  sendResponse({ res, message: "Categorías.", data: { categories: items } });
});

const adminGet = asyncHandler(async (req, res) => {
  const category = await categories.adminGet(req.params.id as string);
  sendResponse({ res, message: "Categoría.", data: { category } });
});

const create = asyncHandler(async (req, res) => {
  const category = await categories.create(req.body, getActor(req));
  sendResponse({ res, statusCode: 201, message: "Categoría creada.", data: { category } });
});

const update = asyncHandler(async (req, res) => {
  const category = await categories.update(req.params.id as string, req.body, getActor(req));
  sendResponse({ res, message: "Categoría actualizada.", data: { category } });
});

const remove = asyncHandler(async (req, res) => {
  await categories.remove(req.params.id as string, getActor(req));
  sendResponse({ res, message: "Categoría archivada.", data: null });
});

export { listPublic, getBySlug, adminList, adminGet, create, update, remove };
