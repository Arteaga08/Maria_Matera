import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { AdminRole } from "@maria-matera/shared";

/**
 * `POST /api/v1/admin/media/video` (content editor subsystem). Cloudinary is
 * mocked at the `config/cloudinary.js` boundary (same approach as
 * `media.service.video.test.ts`) so the real middleware chain — multer MIME
 * whitelist + magic-byte verification — runs against the actual app.
 */

const uploadStreamMock = vi.hoisted(() => vi.fn());
const isCloudinaryConfiguredMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/cloudinary.js", () => ({
  cloudinary: { uploader: { upload_stream: uploadStreamMock } },
  isCloudinaryConfigured: isCloudinaryConfiguredMock,
}));

import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const agentWithRole = async (role: AdminRole) => {
  counter += 1;
  await AdminUser.create({
    username: `media-video-${counter}`,
    email: `media-video-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `media-video-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

// Minimal valid MP4 signature: [size][ftyp][major brand isom] — enough for
// `file-type` to detect video/mp4 without a full playable file.
const minimalMp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from("isomiso2mp41"),
]);

// A real PNG signature spoofed with a video MIME type — must be rejected by
// the magic-byte check even though multer's MIME whitelist lets it through.
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe("POST /api/v1/admin/media/video", () => {
  beforeEach(() => {
    uploadStreamMock.mockReset();
    isCloudinaryConfiguredMock.mockReset();
    isCloudinaryConfiguredMock.mockReturnValue(true);
  });

  it("returns 401 without an admin session", async () => {
    const res = await request(app)
      .post("/api/v1/admin/media/video")
      .attach("video", minimalMp4, { filename: "hero.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when no file is sent", async () => {
    const agent = await agentWithRole(AdminRole.Admin);

    const res = await agent.post("/api/v1/admin/media/video");

    expect(res.status).toBe(400);
  });

  it("returns 400 when the declared MIME type is not an allowed video type", async () => {
    const agent = await agentWithRole(AdminRole.Admin);

    const res = await agent
      .post("/api/v1/admin/media/video")
      .attach("video", pngBytes, { filename: "hero.png", contentType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when the real bytes are not a video (spoofed Content-Type)", async () => {
    const agent = await agentWithRole(AdminRole.Admin);

    const res = await agent
      .post("/api/v1/admin/media/video")
      .attach("video", pngBytes, { filename: "hero.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(400);
  });

  it("uploads a valid video and returns 201 with {url, publicId} (Editor role allowed)", async () => {
    uploadStreamMock.mockImplementation((options, callback) => {
      expect(options).toEqual(expect.objectContaining({ resource_type: "video" }));
      callback(null, {
        secure_url: "https://res.cloudinary.com/demo/video/upload/hero.mp4",
        public_id: "maria-matera/hero123",
      });
      return { end: vi.fn() };
    });
    const agent = await agentWithRole(AdminRole.Editor);

    const res = await agent
      .post("/api/v1/admin/media/video")
      .attach("video", minimalMp4, { filename: "hero.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      url: "https://res.cloudinary.com/demo/video/upload/hero.mp4",
      publicId: "maria-matera/hero123",
    });
  });
});
