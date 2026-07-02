import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/AppError.js";

/**
 * Image upload guard. Multer keeps the file in memory with a size limit and a
 * MIME whitelist (client-declared). `assertImageMagicBytes` then verifies the
 * REAL file signature (magic bytes) so a spoofed Content-Type cannot smuggle a
 * non-image through.
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

const multerInstance = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError("Tipo de archivo no permitido. Usa JPG, PNG, WebP o AVIF.", 400));
    }
  },
});

const uploadSingleImage = multerInstance.single("image");

const assertImageMagicBytes = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!req.file) {
    next(new AppError("No se envió ninguna imagen.", 400));
    return;
  }
  const detected = await fileTypeFromBuffer(req.file.buffer);
  if (!detected || !ALLOWED_MIME.has(detected.mime)) {
    next(new AppError("El archivo no es una imagen válida.", 400));
    return;
  }
  next();
};

export { uploadSingleImage, assertImageMagicBytes };
