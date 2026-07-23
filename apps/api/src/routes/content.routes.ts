import { Router } from "express";
import { AdminRole } from "@maria-matera/shared";
import { protect } from "../middlewares/protect.js";
import { restrictTo } from "../middlewares/restrictTo.js";
import { validate } from "../middlewares/validate.js";
import {
  heroSchema,
  curatedSectionSchema,
  announcementSchema,
} from "../validators/content.validators.js";
import * as ctrl from "../controllers/content.controller.js";

/**
 * Home content routes (content editor subsystem). Public storefront read at
 * `GET /api/v1/content/home`; per-section admin PUTs under
 * `/api/v1/admin/content/home/*`, open to BOTH Admin and Editor — editing
 * storefront content is the reason the Editor role exists.
 */

const publicRouter = Router();
publicRouter.get("/home", ctrl.getPublic);

const adminRouter = Router();
adminRouter.use(protect, restrictTo(AdminRole.Admin, AdminRole.Editor));

adminRouter.get("/home", ctrl.getAdmin);
adminRouter.put("/home/hero", validate(heroSchema), ctrl.updateHero);
adminRouter.put("/home/new-arrivals", validate(curatedSectionSchema), ctrl.updateNewArrivals);
adminRouter.put("/home/best-sellers", validate(curatedSectionSchema), ctrl.updateBestSellers);
adminRouter.put("/home/announcement", validate(announcementSchema), ctrl.updateAnnouncement);

export { publicRouter as contentPublicRouter, adminRouter as contentAdminRouter };
