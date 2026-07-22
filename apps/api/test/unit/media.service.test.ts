import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `uploadRawPdf` (Milestone 8, Task 1). Mirrors the `uploadImage` upload path
 * but with `resource_type: "raw"` for non-image files (PDF certificates).
 * Cloudinary is mocked at the `config/cloudinary.js` boundary, same approach
 * as `email.service.test.ts` mocks `config/email.js`.
 */

const uploadStreamMock = vi.hoisted(() => vi.fn());
const isCloudinaryConfiguredMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/cloudinary.js", () => ({
  cloudinary: { uploader: { upload_stream: uploadStreamMock } },
  isCloudinaryConfigured: isCloudinaryConfiguredMock,
}));

import { uploadRawPdf } from "../../src/services/media.service.js";
import { AppError } from "../../src/utils/AppError.js";

describe("media.service uploadRawPdf", () => {
  beforeEach(() => {
    uploadStreamMock.mockReset();
    isCloudinaryConfiguredMock.mockReset();
  });

  it("calls upload_stream with resource_type 'raw' and resolves {url, publicId} on success", async () => {
    isCloudinaryConfiguredMock.mockReturnValue(true);
    uploadStreamMock.mockImplementation((options, callback) => {
      expect(options).toEqual({ folder: "certificates", resource_type: "raw" });
      callback(null, {
        secure_url: "https://res.cloudinary.com/demo/raw/upload/cert.pdf",
        public_id: "certificates/cert123",
      });
      return { end: vi.fn() };
    });

    const result = await uploadRawPdf(Buffer.from("%PDF-1.4"), "certificates");

    expect(result).toEqual({
      url: "https://res.cloudinary.com/demo/raw/upload/cert.pdf",
      publicId: "certificates/cert123",
    });
  });

  it("rejects with an AppError when Cloudinary returns an error", async () => {
    isCloudinaryConfiguredMock.mockReturnValue(true);
    uploadStreamMock.mockImplementation((_options, callback) => {
      callback(new Error("boom"), null);
      return { end: vi.fn() };
    });

    await expect(uploadRawPdf(Buffer.from("%PDF-1.4"), "certificates")).rejects.toThrow("boom");
  });

  it("throws an AppError when Cloudinary is not configured", () => {
    isCloudinaryConfiguredMock.mockReturnValue(false);

    expect(() => uploadRawPdf(Buffer.from("%PDF-1.4"), "certificates")).toThrow(AppError);
  });
});
