import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import * as ctrl from "../controllers/inventory.controller.js";

/**
 * Admin inventory routes (`/api/v1/admin/inventory`). Restricted to
 * Admin/Editor. Read-only operational stock view; the stock mutation lives at
 * `PATCH /api/v1/admin/variants/:variantId/stock` (product.routes.ts).
 */

const router = Router();
router.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));

router.get("/stats", ctrl.adminStats);
router.get("/", ctrl.adminList);

export { router as adminInventoryRouter };
