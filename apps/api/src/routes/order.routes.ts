import { Router } from "express";
import { protect } from "../middlewares/protect.js";
import { requireCustomer } from "../middlewares/requireCustomer.js";
import { validate } from "../middlewares/validate.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as ctrl from "../controllers/order.controller.js";
import { createOrderSchema } from "../validators/order.validators.js";

/**
 * Customer order routes (`/api/v1/orders`). Fully authenticated, customer-owned
 * resource — `protect` + `requireCustomer` at the router level. Checkout
 * (`POST /`) carries a dedicated rate limiter (anti double-click / anti-abuse)
 * on top of the idempotency key.
 */

const router = Router();
router.use(protect, requireCustomer);

const checkoutLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de compra. Intenta de nuevo en unos minutos.",
});

router.post("/", checkoutLimiter, validate(createOrderSchema), ctrl.create);
router.get("/", ctrl.list);
router.get("/:orderId", ctrl.get);

export { router as orderRouter };
