import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { uploadSingleImage, assertImageMagicBytes } from "../middlewares/upload.js";
import * as ctrl from "../controllers/media.controller.js";

/**
 * Media routes (admin). `POST /api/v1/admin/media` uploads one image field
 * named "image" after MIME + magic-byte validation.
 */

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.post("/", uploadSingleImage, assertImageMagicBytes, ctrl.upload);

export { adminRouter as mediaAdminRouter };
