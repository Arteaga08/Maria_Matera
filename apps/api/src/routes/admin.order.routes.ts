import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import * as ctrl from "../controllers/order.controller.js";
import { advanceOrderSchema, refundOrderSchema } from "../validators/order.validators.js";

/**
 * Admin order routes (`/api/v1/admin/orders`). Restricted to Admin/Editor.
 * Read + status management (advance/cancel via the status endpoint, refund via
 * its dedicated endpoint).
 */

const router = Router();
router.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));

router.get("/stats", ctrl.adminStats);
router.get("/", ctrl.adminList);
router.get("/:orderId", ctrl.adminGet);
router.patch("/:orderId/status", validate(advanceOrderSchema), ctrl.adminAdvance);
router.post("/:orderId/refund", validate(refundOrderSchema), ctrl.adminRefund);

export { router as adminOrderRouter };
