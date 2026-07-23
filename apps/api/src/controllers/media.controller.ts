import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import * as media from "../services/media.service.js";

/**
 * Media controller (admin). Receives a validated image (MIME + magic bytes) and
 * uploads it to Cloudinary.
 */

const MEDIA_FOLDER = "maria-matera";

const upload = asyncHandler(async (req, res) => {
  const result = await media.uploadImage(req.file!.buffer, MEDIA_FOLDER);
  sendResponse({ res, statusCode: 201, message: "Imagen subida.", data: result });
});

const uploadVideo = asyncHandler(async (req, res) => {
  const result = await media.uploadVideo(req.file!.buffer, MEDIA_FOLDER);
  sendResponse({ res, statusCode: 201, message: "Video subido.", data: result });
});

export { upload, uploadVideo };
