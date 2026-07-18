import { Router } from "express";
import { protect } from "../middlewares/protect.js";
import { requireCustomer } from "../middlewares/requireCustomer.js";
import { validate } from "../middlewares/validate.js";
import * as ctrl from "../controllers/cart.controller.js";
import { addItemSchema, updateItemSchema } from "../validators/cart.validators.js";

/**
 * Customer cart routes (`/api/v1/cart`). Fully authenticated, customer-owned
 * resource — `protect` + `requireCustomer` at the router level.
 */

const router = Router();
router.use(protect, requireCustomer);

router.get("/", ctrl.getCart);
router.post("/items", validate(addItemSchema), ctrl.addItem);
router.patch("/items/:itemId", validate(updateItemSchema), ctrl.updateItem);
router.delete("/items/:itemId", ctrl.removeItem);
router.delete("/", ctrl.clearCart);

export { router as cartRouter };
