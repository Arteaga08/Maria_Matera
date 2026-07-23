import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/desire.controller.js";
import { productViewSchema } from "../validators/desire.validators.js";

/**
 * Desire analysis routes. Public anonymous view ingest at
 * `POST /api/v1/events/product-view` (rate-limited — storefront fires one per
 * product page view); read-only admin analysis at `GET /api/v1/admin/desire`.
 */

const publicRouter = Router();
// One sustained view per second per IP is generous for human browsing (even
// offices behind NAT) while trivially capping flood attempts.
const viewLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "Demasiadas solicitudes. Intenta de nuevo más tarde.",
});
publicRouter.post("/product-view", viewLimiter, validate(productViewSchema), ctrl.recordView);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.get("/", ctrl.desireStats);

export { publicRouter as eventPublicRouter, adminRouter as desireAdminRouter };
