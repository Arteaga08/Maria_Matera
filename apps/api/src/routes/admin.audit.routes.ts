import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import * as ctrl from "../controllers/audit.controller.js";

/**
 * Global audit-log routes (`/api/v1/admin/audit`). Admin-ONLY (no Editor):
 * the trail exposes every admin's actions and IPs — a supervision tool for
 * the business owner, same access criterion as the VIP-tier change.
 */

const router = Router();
router.use(protect, restrictTo(AdminRole.Admin));

router.get("/", ctrl.adminList);

export { router as adminAuditRouter };
