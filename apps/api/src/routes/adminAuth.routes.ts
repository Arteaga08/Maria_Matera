import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/adminAuth.controller.js";
import { adminLoginSchema, twoFactorSchema } from "../validators/auth.validators.js";

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

// `/2fa/enable` and `/2fa/disable` verify a submitted TOTP code — the same
// brute-forceable shape as `/login` — so they get the same limiter. `/2fa/setup`
// does not verify a code (it only issues a fresh secret) so it is left unlimited.
const twoFactorLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Demasiados intentos. Intenta de nuevo más tarde.",
});

router.post("/login", loginLimiter, validate(adminLoginSchema), ctrl.login);
router.post("/refresh", ctrl.refresh);
router.post("/logout", ctrl.logout);
router.get("/me", protect, restrictTo(AdminRole.Admin, AdminRole.Editor), ctrl.me);

const adminGuard = [protect, restrictTo(AdminRole.Admin, AdminRole.Editor)] as const;
router.post("/2fa/setup", ...adminGuard, ctrl.setup2fa);
router.post(
  "/2fa/enable",
  ...adminGuard,
  twoFactorLimiter,
  validate(twoFactorSchema),
  ctrl.enable2fa,
);
router.post(
  "/2fa/disable",
  ...adminGuard,
  twoFactorLimiter,
  validate(twoFactorSchema),
  ctrl.disable2fa,
);

export { router as adminAuthRouter };
