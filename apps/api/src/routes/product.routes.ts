import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import * as productCtrl from "../controllers/product.controller.js";
import * as variantCtrl from "../controllers/variant.controller.js";
import * as inventoryCtrl from "../controllers/inventory.controller.js";
import {
  createProductSchema,
  updateProductSchema,
  publishProductSchema,
} from "../validators/product.validators.js";
import {
  createVariantSchema,
  updateVariantSchema,
} from "../validators/variant.validators.js";
import { adjustStockSchema } from "../validators/inventory.validators.js";

/**
 * Product + variant routes. Public catalog at `/api/v1/products`; admin CRUD at
 * `/api/v1/admin/products` and variant edits at `/api/v1/admin/variants`.
 */

const publicRouter = Router();
publicRouter.get("/", productCtrl.listPublic);
publicRouter.get("/:slug", productCtrl.getBySlug);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
adminRouter.get("/", productCtrl.adminList);
adminRouter.get("/:id", productCtrl.adminGet);
adminRouter.post("/", validate(createProductSchema), productCtrl.create);
adminRouter.patch("/:id", validate(updateProductSchema), productCtrl.update);
adminRouter.patch("/:id/publish", validate(publishProductSchema), productCtrl.setPublished);
adminRouter.delete("/:id", productCtrl.remove);
adminRouter.post("/:id/variants", validate(createVariantSchema), variantCtrl.add);

const variantAdminRouter = Router();
variantAdminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));
variantAdminRouter.patch("/:variantId", validate(updateVariantSchema), variantCtrl.update);
variantAdminRouter.patch("/:variantId/stock", validate(adjustStockSchema), inventoryCtrl.adjustStock);
variantAdminRouter.delete("/:variantId", variantCtrl.remove);

export {
  publicRouter as productPublicRouter,
  adminRouter as productAdminRouter,
  variantAdminRouter,
};
