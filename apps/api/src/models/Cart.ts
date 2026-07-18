import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

/**
 * Customer shopping cart. One cart per customer (`customerId` unique).
 * Items only ever store refs + quantity — *never* a price — because
 * `Product.priceCents` is the single source of truth: price is always read
 * fresh at read time (see `cart.service.ts#getPriced`). B2C-only: no
 * wholesale/tier pricing, no promotions applied at this stage.
 */

interface CartItem {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  sku: string;
  qty: number;
}

interface CartDocument extends Document {
  customerId: Types.ObjectId;
  items: Types.DocumentArray<CartItem>;
  createdAt: Date;
  updatedAt: Date;
}

const cartItemSchema = new Schema<CartItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    sku: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: true },
);

const cartSchema = new Schema<CartDocument>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      unique: true,
      index: true,
    },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true },
);

const Cart: Model<CartDocument> =
  (models.Cart as Model<CartDocument>) ?? model<CartDocument>("Cart", cartSchema);

export type { CartDocument, CartItem };
export { Cart };
