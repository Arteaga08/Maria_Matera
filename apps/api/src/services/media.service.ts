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

export type { UploadResult };
export { uploadImage };
