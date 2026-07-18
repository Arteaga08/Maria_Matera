import { Router } from "express";
import { protect } from "../middlewares/protect.js";
import { requireCustomer } from "../middlewares/requireCustomer.js";
import { validate } from "../middlewares/validate.js";
import * as ctrl from "../controllers/address.controller.js";
import { createAddressSchema, updateAddressSchema } from "../validators/address.validators.js";

/**
 * Customer address book routes (`/api/v1/addresses`). Fully authenticated,
 * customer-owned resource — `protect` + `requireCustomer` at the router level.
 */

const router = Router();
router.use(protect, requireCustomer);

router.get("/", ctrl.list);
router.post("/", validate(createAddressSchema), ctrl.create);
router.patch("/:addressId", validate(updateAddressSchema), ctrl.update);
router.delete("/:addressId", ctrl.remove);

export { router as addressRouter };
