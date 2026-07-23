import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import * as ctrl from "../controllers/customer.admin.controller.js";
import { changeTierSchema } from "../validators/customer.validators.js";

/**
 * Admin CRM routes (`/api/v1/admin/customers`). Reads are Admin/Editor; the
 * tier change is Admin-only (VIP unlocks exclusive coupons/products — a
 * business decision, not an editorial one).
 */

const router = Router();
router.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));

router.get("/stats", ctrl.adminStats);
router.get("/", ctrl.adminList);
router.get("/:customerId", ctrl.adminGet);
router.patch(
  "/:customerId/tier",
  restrictTo(AdminRole.Admin),
  validate(changeTierSchema),
  ctrl.changeTier,
);

export { router as adminCustomerRouter };
