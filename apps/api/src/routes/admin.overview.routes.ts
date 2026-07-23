import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import * as ctrl from "../controllers/overview.controller.js";

/**
 * Dashboard overview route (admin). Read-only composition of the
 * per-subsystem stats — Admin and Editor, like every other stats endpoint.
 */

const router = Router();
router.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));

router.get("/", ctrl.adminOverview);

export { router as adminOverviewRouter };
