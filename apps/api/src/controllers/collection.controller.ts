import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as collections from "../services/collection.service.js";

/**
 * Collection controllers. Public reads (active) + admin CRUD.
 */

const listPublic = asyncHandler(async (_req, res) => {
  const items = await collections.listPublic();
  sendResponse({ res, message: "Colecciones activas.", data: { collections: items } });
});

const getBySlug = asyncHandler(async (req, res) => {
  const collection = await collections.getBySlug(req.params.slug as string);
  sendResponse({ res, message: "Colección.", data: { collection } });
});

const adminList = asyncHandler(async (_req, res) => {
  const items = await collections.adminList();
  sendResponse({ res, message: "Colecciones.", data: { collections: items } });
});

const adminGet = asyncHandler(async (req, res) => {
  const collection = await collections.adminGet(req.params.id as string);
  sendResponse({ res, message: "Colección.", data: { collection } });
});

const create = asyncHandler(async (req, res) => {
  const collection = await collections.create(req.body, getActor(req));
  sendResponse({ res, statusCode: 201, message: "Colección creada.", data: { collection } });
});

const update = asyncHandler(async (req, res) => {
  const collection = await collections.update(req.params.id as string, req.body, getActor(req));
  sendResponse({ res, message: "Colección actualizada.", data: { collection } });
});

const remove = asyncHandler(async (req, res) => {
  await collections.remove(req.params.id as string, getActor(req));
  sendResponse({ res, message: "Colección archivada.", data: null });
});

export { listPublic, getBySlug, adminList, adminGet, create, update, remove };
