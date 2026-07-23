import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { requireCustomer } from "../middlewares/requireCustomer.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import * as ctrl from "../controllers/certificate.controller.js";

/**
 * Certificate routes (Milestone 8, Task 3). Purely customer-owned reads under
 * `/api/v1/certificates` (`protect` + `requireCustomer`) plus a separate
 * admin-only reissue action under `/api/v1/admin/certificates` (`protect` +
 * Admin/Editor) — no public route, unlike Milestone 7's shipping tracking.
 *
 * No Joi validators: every endpoint here takes its id purely from a `:certId`
 * URL param (resolved by Mongoose's ObjectId cast → `CastError` → `AppError`
 * via the global error handler, same as `:orderId` elsewhere) and none of
 * them accept a request body, so there is nothing for `validate(schema)` to
 * validate.
 */

const router = Router();
router.use(protect, requireCustomer);

router.get("/", ctrl.list);
router.get("/:certId/download", ctrl.download);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));

adminRouter.get("/", ctrl.adminList);
adminRouter.post("/:certId/reissue", ctrl.adminReissue);

export { router as certificateRouter, adminRouter as certificateAdminRouter };
