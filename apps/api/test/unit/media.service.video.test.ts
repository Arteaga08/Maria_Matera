import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `uploadVideo` (content editor subsystem). Mirrors the `uploadImage` upload
 * path but with `resource_type: "video"` for hero-slide videos. Cloudinary is
 * mocked at the `config/cloudinary.js` boundary, same approach as
 * `media.service.test.ts`.
 */

const uploadStreamMock = vi.hoisted(() => vi.fn());
const isCloudinaryConfiguredMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/cloudinary.js", () => ({
  cloudinary: { uploader: { upload_stream: uploadStreamMock } },
  isCloudinaryConfigured: isCloudinaryConfiguredMock,
}));

import { uploadVideo } from "../../src/services/media.service.js";
import { AppError } from "../../src/utils/AppError.js";

describe("media.service uploadVideo", () => {
  beforeEach(() => {
    uploadStreamMock.mockReset();
    isCloudinaryConfiguredMock.mockReset();
  });

  it("calls upload_stream with resource_type 'video' and resolves {url, publicId} on success", async () => {
    isCloudinaryConfiguredMock.mockReturnValue(true);
    uploadStreamMock.mockImplementation((options, callback) => {
      expect(options).toEqual({ folder: "content", resource_type: "video" });
      callback(null, {
        secure_url: "https://res.cloudinary.com/demo/video/upload/hero.mp4",
        public_id: "content/hero123",
      });
      return { end: vi.fn() };
    });

    const result = await uploadVideo(Buffer.from("ftyp"), "content");

    expect(result).toEqual({
      url: "https://res.cloudinary.com/demo/video/upload/hero.mp4",
      publicId: "content/hero123",
    });
  });

  it("rejects with an AppError when Cloudinary returns an error", async () => {
    isCloudinaryConfiguredMock.mockReturnValue(true);
    uploadStreamMock.mockImplementation((_options, callback) => {
      callback(new Error("boom"), null);
      return { end: vi.fn() };
    });

    await expect(uploadVideo(Buffer.from("ftyp"), "content")).rejects.toThrow("boom");
  });

  it("rejects with a fallback AppError when Cloudinary returns no result", async () => {
    isCloudinaryConfiguredMock.mockReturnValue(true);
    uploadStreamMock.mockImplementation((_options, callback) => {
      callback(null, null);
      return { end: vi.fn() };
    });

    await expect(uploadVideo(Buffer.from("ftyp"), "content")).rejects.toThrow(AppError);
  });

  it("throws an AppError when Cloudinary is not configured", () => {
    isCloudinaryConfiguredMock.mockReturnValue(false);

    expect(() => uploadVideo(Buffer.from("ftyp"), "content")).toThrow(AppError);
  });
});
