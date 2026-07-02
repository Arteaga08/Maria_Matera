import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import * as ctrl from "../controllers/category.controller.js";
import { createCategorySchema, updateCategorySchema } from "../validators/category.validators.js";

/**
 * Category routes. Public reads at `/api/v1/categories`; admin CRUD at
 * `/api/v1/admin/categories` (guarded by protect + restrictTo).
 */

const publicRouter = Router();
publicRouter.get("/", ctrl.listPublic);
publicRouter.get("/:slug", ctrl.getBySlug);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.get("/", ctrl.adminList);
adminRouter.get("/:id", ctrl.adminGet);
adminRouter.post("/", validate(createCategorySchema), ctrl.create);
adminRouter.patch("/:id", validate(updateCategorySchema), ctrl.update);
adminRouter.delete("/:id", ctrl.remove);

export { publicRouter as categoryPublicRouter, adminRouter as categoryAdminRouter };
