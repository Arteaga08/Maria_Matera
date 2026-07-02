import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

/**
 * Cloudinary client for media hosting. Credentials live only on the server.
 * `isCloudinaryConfigured` lets the upload path fail with a clear message when
 * credentials are missing (e.g. local dev without a Cloudinary account).
 */

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
  secure: true,
});

const isCloudinaryConfigured = (): boolean =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);

export { cloudinary, isCloudinaryConfigured };
