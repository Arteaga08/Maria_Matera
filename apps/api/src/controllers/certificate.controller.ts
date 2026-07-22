import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { getActor } from "../utils/actor.js";
import * as certificateService from "../services/certificate.service.js";

/**
 * Certificate controllers (Milestone 8, Task 3). Owner endpoints are scoped to
 * `req.auth.id` (the authenticated customer) — never an id from
 * params/body — so a customer can never read another customer's certificate.
 * `download` returns the stored `pdfUrl` as JSON (matching this API's
 * all-JSON-envelope convention), not an HTTP redirect — the frontend decides
 * how to trigger the actual download from that URL.
 */

// --- Owner-facing ------------------------------------------------------------

const list = asyncHandler(async (req, res) => {
  const certificates = await certificateService.listMine(req.auth!.id);
  sendResponse({ res, message: "Mis certificados.", data: { certificates } });
});

const download = asyncHandler(async (req, res) => {
  const certificate = await certificateService.getMineDownload(
    req.auth!.id,
    req.params.certId as string,
  );
  sendResponse({ res, message: "Certificado.", data: { pdfUrl: certificate.pdfUrl } });
});

// --- Admin-facing ------------------------------------------------------------

const adminReissue = asyncHandler(async (req, res) => {
  const certificate = await certificateService.adminReissue(
    req.params.certId as string,
    getActor(req),
  );
  sendResponse({ res, message: "Certificado reemitido.", data: { certificate } });
});

export { list, download, adminReissue };
