import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import * as ctrl from "../controllers/collection.controller.js";
import {
  createCollectionSchema,
  updateCollectionSchema,
} from "../validators/collection.validators.js";

/**
 * Collection routes. Public reads at `/api/v1/collections`; admin CRUD at
 * `/api/v1/admin/collections`.
 */

const publicRouter = Router();
publicRouter.get("/", ctrl.listPublic);
publicRouter.get("/:slug", ctrl.getBySlug);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.get("/", ctrl.adminList);
adminRouter.get("/:id", ctrl.adminGet);
adminRouter.post("/", validate(createCollectionSchema), ctrl.create);
adminRouter.patch("/:id", validate(updateCollectionSchema), ctrl.update);
adminRouter.delete("/:id", ctrl.remove);

export { publicRouter as collectionPublicRouter, adminRouter as collectionAdminRouter };
