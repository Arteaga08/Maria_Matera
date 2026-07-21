import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/shipping.controller.js";
import {
  assignGuideSchema,
  editGuideSchema,
  revertShipmentSchema,
  deliverSchema,
  processingSchema,
} from "../validators/shipping.validators.js";

/**
 * Shipping routes (Milestone 7, Task 4). Admin mutations + read at
 * `/api/v1/admin/shipping` (Admin/Editor only, guarded once at router level —
 * never rate-limited, auth+role is the barrier); public tracking read at
 * `/api/v1/tracking` (rate-limited, anti-enumeration, same posture as
 * `coupon.routes.ts`'s `/validate`).
 */

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.patch("/:orderId/assign-guide", validate(assignGuideSchema), ctrl.assignGuide);
adminRouter.patch("/:orderId/deliver", validate(deliverSchema), ctrl.deliver);
adminRouter.patch("/:orderId/edit-guide", validate(editGuideSchema), ctrl.editGuide);
adminRouter.patch("/:orderId/revert", validate(revertShipmentSchema), ctrl.revert);
adminRouter.patch("/:orderId/processing", validate(processingSchema), ctrl.processing);
adminRouter.get("/:orderId", ctrl.getShipment);

const publicRouter = Router();
const trackLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Demasiados intentos. Intenta de nuevo más tarde.",
});
publicRouter.get("/:trackingNumber", trackLimiter, ctrl.track);

export { adminRouter as shippingAdminRouter, publicRouter as shippingPublicRouter };
