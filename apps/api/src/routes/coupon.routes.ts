import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/coupon.controller.js";
import {
  createCouponSchema,
  updateCouponSchema,
  validateCouponSchema,
} from "../validators/coupon.validators.js";

/**
 * Coupon routes. Public validation at `/api/v1/coupons/validate` (rate-limited
 * to deter code enumeration); admin CRUD at `/api/v1/admin/coupons`.
 */

const publicRouter = Router();
const validateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Demasiados intentos. Intenta de nuevo más tarde.",
});
publicRouter.post("/validate", validateLimiter, validate(validateCouponSchema), ctrl.validatePublic);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.get("/", ctrl.adminList);
adminRouter.get("/:id", ctrl.adminGet);
adminRouter.get("/:id/performance", ctrl.adminPerformance);
adminRouter.post("/", validate(createCouponSchema), ctrl.create);
adminRouter.patch("/:id", validate(updateCouponSchema), ctrl.update);
adminRouter.delete("/:id", ctrl.remove);

export { publicRouter as couponPublicRouter, adminRouter as couponAdminRouter };
