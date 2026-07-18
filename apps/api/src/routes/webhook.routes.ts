import { Router, raw } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { stripeWebhook } from "../controllers/webhook.controller.js";

/**
 * Payment webhook routes. Mounted at the very START of `buildApp`, BEFORE
 * `express.json()` and every cookie/sanitizer/origin/rate-limit middleware, so
 * `express.raw` preserves the exact bytes Stripe signed (JSON parsing would
 * consume them and break signature verification). Auth is the Stripe signature,
 * not cookies — this router deliberately bypasses `verifyOrigin`/`protect`.
 */

const router = Router();

router.post("/stripe", raw({ type: "application/json" }), asyncHandler(stripeWebhook));

export { router as webhookRouter };
