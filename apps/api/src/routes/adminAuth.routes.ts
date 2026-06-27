import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/adminAuth.controller.js";
import { adminLoginSchema } from "../validators/auth.validators.js";

/**
 * Admin auth routes (`/api/v1/admin/auth`). Protected reads require an admin
 * principal via `protect` + `restrictTo`.
 */

const router = Router();

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Demasiados intentos. Intenta de nuevo más tarde.",
});

router.post("/login", loginLimiter, validate(adminLoginSchema), ctrl.login);
router.post("/refresh", ctrl.refresh);
router.post("/logout", ctrl.logout);
router.get("/me", protect, restrictTo(AdminRole.Admin, AdminRole.Editor), ctrl.me);

export { router as adminAuthRouter };
