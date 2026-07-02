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
adminRouter.post("/broadcast/:couponId", ctrl.broadcast);

export { publicRouter as newsletterPublicRouter, adminRouter as marketingAdminRouter };
