import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { protect } from "../middlewares/protect.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/customerAuth.controller.js";
import {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../validators/auth.validators.js";

/**
 * Customer auth routes (`/api/v1/auth`). Sensitive actions get dedicated
 * per-action rate limiters (no-op outside production).
 */

const router = Router();

const WINDOW_MS = 15 * 60 * 1000;
const loginLimiter = createRateLimiter({
  windowMs: WINDOW_MS,
  max: 5,
  message: "Demasiados intentos. Intenta de nuevo más tarde.",
});
const sensitiveLimiter = createRateLimiter({
  windowMs: WINDOW_MS,
  max: 10,
  message: "Demasiadas solicitudes. Intenta de nuevo más tarde.",
});

router.post("/register", sensitiveLimiter, validate(registerSchema), ctrl.register);
router.post("/verify-email", validate(verifyEmailSchema), ctrl.verifyEmail);
router.post("/login", loginLimiter, validate(loginSchema), ctrl.login);
router.post("/refresh", ctrl.refresh);
router.post("/logout", ctrl.logout);
router.post("/forgot-password", sensitiveLimiter, validate(forgotPasswordSchema), ctrl.forgotPassword);
router.post("/reset-password", sensitiveLimiter, validate(resetPasswordSchema), ctrl.resetPassword);
router.get("/me", protect, ctrl.me);

export { router as customerAuthRouter };
