import { cloudinary, isCloudinaryConfigured } from "../config/cloudinary.js";
import { AppError } from "../utils/AppError.js";

/**
 * Uploads an in-memory image buffer to Cloudinary and returns the secure URL +
 * public id. Credentials are validated up front so misconfiguration fails with
 * a clear message instead of a cryptic provider error.
 */

interface UploadResult {
  url: string;
  publicId: string;
}

const uploadImage = (buffer: Buffer, folder: string): Promise<UploadResult> => {
  if (!isCloudinaryConfigured()) {
    throw new AppError("El servicio de imágenes no está configurado.", 503);
  }
  return new Promise<UploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new AppError("No se pudo subir la imagen.", 502));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
};

const uploadRawPdf = (buffer: Buffer, folder: string): Promise<UploadResult> => {
  if (!isCloudinaryConfigured()) {
    throw new AppError("El servicio de archivos no está configurado.", 503);
  }
  return new Promise<UploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "raw" },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new AppError("No se pudo subir el archivo.", 502));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
};

/**
 * Deletes a previously-uploaded raw (non-image) asset, e.g. a superseded
 * certificate PDF. Mirrors `uploadRawPdf`'s structure. Rejects normally on
 * failure (does NOT swallow errors) — callers that only want this as a
 * best-effort cleanup step are responsible for wrapping the call in their own
 * try/catch, same as any other fallible operation in this service.
 */
const deleteRawAsset = (publicId: string): Promise<void> => {
  if (!isCloudinaryConfigured()) {
    throw new AppError("El servicio de archivos no está configurado.", 503);
  }
  return new Promise<void>((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, { resource_type: "raw" }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

export type { UploadResult };
export { uploadImage, uploadRawPdf, deleteRawAsset };
