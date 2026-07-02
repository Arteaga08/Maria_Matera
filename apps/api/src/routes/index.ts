import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { customerAuthRouter } from "./customerAuth.routes.js";
import { adminAuthRouter } from "./adminAuth.routes.js";
import { categoryPublicRouter, categoryAdminRouter } from "./category.routes.js";
import { collectionPublicRouter, collectionAdminRouter } from "./collection.routes.js";
import { productPublicRouter, productAdminRouter, variantAdminRouter } from "./product.routes.js";
import { mediaAdminRouter } from "./media.routes.js";
import { couponPublicRouter, couponAdminRouter } from "./coupon.routes.js";
import { newsletterPublicRouter, marketingAdminRouter } from "./subscriber.routes.js";

/**
 * API v1 router aggregator. Feature routers (auth, catalog, ...) are mounted
 * here as each one lands in Bloque 1.
 */

const apiRouter = Router();

// Health
apiRouter.use("/health", healthRouter);

// Auth
apiRouter.use("/auth", customerAuthRouter);
apiRouter.use("/admin/auth", adminAuthRouter);

// Catalog — public
apiRouter.use("/categories", categoryPublicRouter);
apiRouter.use("/collections", collectionPublicRouter);
apiRouter.use("/products", productPublicRouter);
apiRouter.use("/coupons", couponPublicRouter);
apiRouter.use("/newsletter", newsletterPublicRouter);

// Catalog — admin
apiRouter.use("/admin/categories", categoryAdminRouter);
apiRouter.use("/admin/collections", collectionAdminRouter);
apiRouter.use("/admin/products", productAdminRouter);
apiRouter.use("/admin/variants", variantAdminRouter);
apiRouter.use("/admin/media", mediaAdminRouter);
apiRouter.use("/admin/coupons", couponAdminRouter);
apiRouter.use("/admin/marketing", marketingAdminRouter);

export { apiRouter };
