import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/subscriber.controller.js";
import { subscribeSchema } from "../validators/subscriber.validators.js";

/**
 * Newsletter routes. Public subscribe/confirm/unsubscribe at `/api/v1/newsletter`;
 * admin coupon broadcast at `/api/v1/admin/marketing`.
 */

const publicRouter = Router();
const subscribeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiadas solicitudes. Intenta de nuevo más tarde.",
});
publicRouter.post("/subscribe", subscribeLimiter, validate(subscribeSchema), ctrl.subscribe);
publicRouter.get("/confirm", ctrl.confirm);
publicRouter.get("/unsubscribe", ctrl.unsubscribe);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
// Broadcasting emails the ENTIRE confirmed subscriber list — a double-click,
// client retry, or compromised Editor session re-firing this repeatedly would
// spam real customers and burn email-provider quota. Unlike ordinary admin
// CRUD (guarded by auth + role alone, per `rateLimit.ts`'s header), this
// mass-send action gets its own light limiter too.
const broadcastLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Demasiados envíos de cupón. Intenta de nuevo más tarde.",
});
adminRouter.post("/broadcast/:couponId", broadcastLimiter, ctrl.broadcast);

export { publicRouter as newsletterPublicRouter, adminRouter as marketingAdminRouter };
