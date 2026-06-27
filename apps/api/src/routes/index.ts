import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { customerAuthRouter } from "./customerAuth.routes.js";
import { adminAuthRouter } from "./adminAuth.routes.js";

/**
 * API v1 router aggregator. Feature routers (auth, products, orders, ...) are
 * mounted here as each one lands in Bloque 1.
 */

const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", customerAuthRouter);
apiRouter.use("/admin/auth", adminAuthRouter);

export { apiRouter };
