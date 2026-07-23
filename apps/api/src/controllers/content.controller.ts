import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as contentService from "../services/content.service.js";
import type { CuratedSectionName } from "../services/content.service.js";

/**
 * Home content controllers. Thin HTTP layer over `content.service.ts` —
 * `getPublic` is the sole unauthenticated handler (storefront home); every
 * admin mutation tags the audit entry with `getActor(req)`.
 */

const getPublic = asyncHandler(async (_req, res) => {
  const content = await contentService.getPublic();
  sendResponse({ res, message: "Contenido del home.", data: content });
});

const getAdmin = asyncHandler(async (_req, res) => {
  const content = await contentService.getAdmin();
  sendResponse({ res, message: "Contenido del home.", data: { content } });
});

const updateHero = asyncHandler(async (req, res) => {
  const content = await contentService.updateHero({ slides: req.body.slides }, getActor(req));
  sendResponse({ res, message: "Hero actualizado.", data: { content } });
});

const updateCuratedSection = (section: CuratedSectionName, message: string) =>
  asyncHandler(async (req, res) => {
    const content = await contentService.updateCuratedSection(
      section,
      { productIds: req.body.productIds, isActive: req.body.isActive },
      getActor(req),
    );
    sendResponse({ res, message, data: { content } });
  });

const updateNewArrivals = updateCuratedSection("newArrivals", "Novedades actualizadas.");
const updateBestSellers = updateCuratedSection("bestSellers", "Best sellers actualizados.");

const updateAnnouncement = asyncHandler(async (req, res) => {
  const content = await contentService.updateAnnouncement(
    { text: req.body.text, href: req.body.href, type: req.body.type, isActive: req.body.isActive },
    getActor(req),
  );
  sendResponse({ res, message: "Anuncio actualizado.", data: { content } });
});

export { getPublic, getAdmin, updateHero, updateNewArrivals, updateBestSellers, updateAnnouncement };
