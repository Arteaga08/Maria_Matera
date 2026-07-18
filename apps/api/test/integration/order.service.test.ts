import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import {
  CouponType,
  CustomerTier,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
} from "@maria-matera/shared";

/**
 * The Stripe adapter is mocked at its module boundary so `createOrder`'s
 * post-transaction PaymentIntent call (and the admin refund's Stripe call) never
 * hit the network. The order/inventory/state logic under test is 100% real.
 */
const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));
import { Customer } from "../../src/models/Customer.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import { Coupon } from "../../src/models/Coupon.js";
import { CouponRedemption } from "../../src/models/CouponRedemption.js";
import { Order } from "../../src/models/Order.js";
import { StockReservation } from "../../src/models/StockReservation.js";
import * as orderService from "../../src/services/order.service.js";

/**
 * Order service (Milestone 5, Task 4) — the critical money/inventory/state
 * module. Driven against a real replica set so `createOrder`'s single
 * transaction (pricing recompute, stock reservation, coupon redemption, order
 * snapshot, cart clear) is exercised end-to-end, mirroring the transaction
 * style of `coupon-redeem.test.ts` / `inventory.test.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;
let counter = 0;
let piSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.retrievePaymentIntent.mockReset();
  stripeMock.refund.mockReset();
  // Each order gets a fresh, unique PaymentIntent ref + client secret.
  stripeMock.createPaymentIntent.mockImplementation(async () => {
    piSeq += 1;
    return { ref: `pi_mock_${piSeq}`, clientSecret: `cs_mock_${piSeq}` };
  });
  stripeMock.retrievePaymentIntent.mockImplementation(async (ref: string) => ({
    ref,
    status: "requires_payment_method",
    clientSecret: `cs_for_${ref}`,
  }));
  stripeMock.refund.mockResolvedValue(undefined);
});

const address = (overrides: Record<string, unknown> = {}) => ({
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
  ...overrides,
});

const makeCustomer = async (tier: CustomerTier = CustomerTier.Standard) => {
  counter += 1;
  const customer = await Customer.create({
    name: "Cliente",
    email: `order-svc-${counter}@test.com`,
    password: "Password123",
    tier,
    addresses: [address({ label: "Envío" }), address({ label: "Facturación" })],
  });
  return {
    customer,
    customerId: customer.id as string,
    shippingAddressId: customer.addresses[0]!._id.toString(),
    billingAddressId: customer.addresses[1]!._id.toString(),
  };
};

const makeProduct = async (priceCents = 100000, onHand = 10) => {
  counter += 1;
  const product = await Product.create({
    name: `Anillo ${counter}`,
    slug: `anillo-svc-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-SVC-${counter}`,
    onHand,
  });
  return { product, variant };
};

const seedCart = async (
  customerId: string,
  lines: { product: { _id: mongoose.Types.ObjectId }; variant: { _id: mongoose.Types.ObjectId; sku: string }; qty: number }[],
) =>
  Cart.create({
    customerId,
    items: lines.map((line) => ({
      productId: line.product._id,
      variantId: line.variant._id,
      sku: line.variant.sku,
      qty: line.qty,
    })),
  });

const makeCoupon = (overrides: Record<string, unknown> = {}) =>
  Coupon.create({
    code: `SVC-${Math.random().toString(36).slice(2, 8)}`,
    type: CouponType.Percent,
    value: 10,
    validFrom: new Date(Date.now() - DAY),
    validTo: new Date(Date.now() + DAY),
    ...overrides,
  });

describe("Order service — createOrder", () => {
  it("creates an immutable order snapshot from live catalog prices and clears the cart", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(150000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]);

    const { order } = await orderService.createOrder(customerId, {
      idempotencyKey: "key-success-1",
      shippingAddressId,
      billingAddressId,
    });

    expect(order.status).toBe(OrderStatus.PendingPayment);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.unitPriceCents).toBe(150000);
    expect(order.items[0]!.lineSubtotalCents).toBe(300000);
    expect(order.subtotalCents).toBe(300000);
    expect(order.totalCents).toBe(300000);
    expect(order.currency).toBe("MXN");
    expect(order.payment.provider).toBe(PaymentProvider.Stripe);
    expect(order.payment.status).toBe(PaymentStatus.Pending);
    // Task 5: createOrder now creates the PaymentIntent post-transaction, so the
    // gateway ref is persisted (payment status stays pending until confirmed).
    expect(order.payment.ref).toMatch(/^pi_mock_/);
    expect(order.shippingAddress.label).toBe("Envío");
    expect(order.billingAddress.label).toBe("Facturación");

    // Reservation created, linked back to the order, stock held.
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.orderId!.toString()).toBe(order.id);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(2);

    // Cart emptied.
    const cart = await Cart.findOne({ customerId });
    expect(cart!.items).toHaveLength(0);
  });

  it("snapshot survives a later catalog price change", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 5);
    await seedCart(customerId, [{ product, variant, qty: 1 }]);

    const { order } = await orderService.createOrder(customerId, {
      idempotencyKey: "key-immutable-1",
      shippingAddressId,
      billingAddressId,
    });

    await Product.updateOne({ _id: product._id }, { priceCents: 999999 });

    const reloaded = await Order.findById(order.id);
    expect(reloaded!.items[0]!.unitPriceCents).toBe(100000);
    expect(reloaded!.totalCents).toBe(100000);
  });

  it("is idempotent: the same key returns the same order without double-reserving stock", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]);

    const { order: first } = await orderService.createOrder(customerId, {
      idempotencyKey: "key-idem-1",
      shippingAddressId,
      billingAddressId,
    });
    const { order: second } = await orderService.createOrder(customerId, {
      idempotencyKey: "key-idem-1",
      shippingAddressId,
      billingAddressId,
    });

    expect(second.id).toBe(first.id);
    expect(await Order.countDocuments({ customerId })).toBe(1);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(2); // not 4
  });

  it("is safe under a TRUE concurrent double-submit: exactly one order, one reservation's worth of stock, one redemption", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]); // subtotal 200000
    const coupon = await makeCoupon({ value: 10 });

    // Fire two createOrder calls in parallel with the SAME idempotency key.
    // Mirrors coupon-redeem.test.ts's Promise.allSettled concurrency test: this
    // exercises the E11000 catch-fallback (the real concurrent guard), not the
    // sequential fast-path.
    const attempt = () =>
      orderService.createOrder(customerId, {
        idempotencyKey: "key-concurrent-1",
        shippingAddressId,
        billingAddressId,
        couponCode: coupon.code,
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    // Both calls should resolve to the same order (loser returns the winner's
    // order via the E11000 fallback) — neither should error out.
    expect(fulfilled).toHaveLength(2);
    const ids = new Set(
      fulfilled.map(
        (r) => (r as PromiseFulfilledResult<{ order: { id: string } }>).value.order.id,
      ),
    );
    expect(ids.size).toBe(1);

    // Exactly one order for the key.
    expect(await Order.countDocuments({ customerId })).toBe(1);
    // Exactly one reservation's worth of stock held (not double).
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(2);
    expect(await StockReservation.countDocuments({ status: "active" })).toBe(1);
    // Exactly one coupon redemption recorded (not two).
    const reloadedCoupon = await Coupon.findById(coupon.id);
    expect(reloadedCoupon!.usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ couponId: coupon._id })).toBe(1);
  });

  it("applies a percent coupon and records its code, and does not double-redeem on retry", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]); // subtotal 200000
    const coupon = await makeCoupon({ value: 10 });

    const { order } = await orderService.createOrder(customerId, {
      idempotencyKey: "key-coupon-1",
      shippingAddressId,
      billingAddressId,
      couponCode: coupon.code,
    });

    expect(order.couponCode).toBe(coupon.code);
    expect(order.discountCents).toBe(20000); // 10% of 200000
    expect(order.totalCents).toBe(180000);

    // Retry must not redeem again.
    await orderService.createOrder(customerId, {
      idempotencyKey: "key-coupon-1",
      shippingAddressId,
      billingAddressId,
      couponCode: coupon.code,
    });
    const reloadedCoupon = await Coupon.findById(coupon.id);
    expect(reloadedCoupon!.usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ couponId: coupon._id })).toBe(1);
  });

  // Final whole-branch review gap: `couponService.redeem` previously never
  // checked `isVipOnly`, so ANY customer could redeem a VIP-exclusive coupon at
  // actual checkout. These confirm `createOrder` now threads the customer's
  // REAL, already-loaded tier through to `redeem` correctly in both directions.
  it("succeeds when a genuine VIP customer redeems an isVipOnly coupon at checkout", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer(
      CustomerTier.Vip,
    );
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]); // subtotal 200000
    const coupon = await makeCoupon({ value: 10, isVipOnly: true });

    const { order } = await orderService.createOrder(customerId, {
      idempotencyKey: "key-vip-coupon-1",
      shippingAddressId,
      billingAddressId,
      couponCode: coupon.code,
    });

    expect(order.couponCode).toBe(coupon.code);
    expect(order.discountCents).toBe(20000); // 10% of 200000
    const reloadedCoupon = await Coupon.findById(coupon.id);
    expect(reloadedCoupon!.usedCount).toBe(1);
  });

  it("rejects checkout when a non-VIP customer tries to redeem an isVipOnly coupon, rolling back the reservation", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer(
      CustomerTier.Standard,
    );
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]);
    const coupon = await makeCoupon({ isVipOnly: true });

    await expect(
      orderService.createOrder(customerId, {
        idempotencyKey: "key-nonvip-coupon-1",
        shippingAddressId,
        billingAddressId,
        couponCode: coupon.code,
      }),
    ).rejects.toThrow(/exclusivo para clientes VIP/);

    expect(await Order.countDocuments({ customerId })).toBe(0);
    const reloadedCoupon = await Coupon.findById(coupon.id);
    expect(reloadedCoupon!.usedCount).toBe(0); // never redeemed
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0); // reservation rolled back
  });

  it("rolls back the WHOLE transaction on insufficient stock — no order, no reservation, coupon NOT redeemed", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 1); // only 1 in stock
    await seedCart(customerId, [{ product, variant, qty: 2 }]); // wants 2
    const coupon = await makeCoupon();

    await expect(
      orderService.createOrder(customerId, {
        idempotencyKey: "key-oversell-1",
        shippingAddressId,
        billingAddressId,
        couponCode: coupon.code,
      }),
    ).rejects.toThrow();

    expect(await Order.countDocuments({ customerId })).toBe(0);
    expect(await StockReservation.countDocuments({})).toBe(0);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0);
    const reloadedCoupon = await Coupon.findById(coupon.id);
    expect(reloadedCoupon!.usedCount).toBe(0); // reservation failed first
    // Cart untouched (order aborted).
    const cart = await Cart.findOne({ customerId });
    expect(cart!.items).toHaveLength(1);
  });

  it("rolls back the reserved stock when coupon redemption fails after a successful reservation", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]);

    await expect(
      orderService.createOrder(customerId, {
        idempotencyKey: "key-badcoupon-1",
        shippingAddressId,
        billingAddressId,
        couponCode: "DOES-NOT-EXIST",
      }),
    ).rejects.toThrow();

    expect(await Order.countDocuments({ customerId })).toBe(0);
    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0); // reservation rolled back
  });

  it("rejects checkout when a cart line is silently excluded (unpurchasable) by pricing", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const good = await makeProduct(100000, 10);
    const bad = await makeProduct(50000, 10);
    await seedCart(customerId, [
      { product: good.product, variant: good.variant, qty: 1 },
      { product: bad.product, variant: bad.variant, qty: 1 },
    ]);
    // The second product becomes unpublished after being added.
    await Product.updateOne({ _id: bad.product._id }, { isPublished: false });

    await expect(
      orderService.createOrder(customerId, {
        idempotencyKey: "key-silent-1",
        shippingAddressId,
        billingAddressId,
      }),
    ).rejects.toThrow(/disponibles/i);

    expect(await Order.countDocuments({ customerId })).toBe(0);
    expect(await StockReservation.countDocuments({})).toBe(0);
  });

  it("rejects an address id that belongs to another customer (anti-IDOR)", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(owner.customerId, [{ product, variant, qty: 1 }]);

    await expect(
      orderService.createOrder(owner.customerId, {
        idempotencyKey: "key-idor-1",
        shippingAddressId: other.shippingAddressId, // not the owner's
        billingAddressId: owner.billingAddressId,
      }),
    ).rejects.toThrow();

    expect(await Order.countDocuments({ customerId: owner.customerId })).toBe(0);
  });

  it("rejects checkout with an empty cart", async () => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    await expect(
      orderService.createOrder(customerId, {
        idempotencyKey: "key-empty-1",
        shippingAddressId,
        billingAddressId,
      }),
    ).rejects.toThrow();
  });
});

describe("Order service — reads (anti-IDOR)", () => {
  it("getMine returns the owner's order but 404s another customer's order id", async () => {
    const owner = await makeCustomer();
    const intruder = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(owner.customerId, [{ product, variant, qty: 1 }]);

    const { order } = await orderService.createOrder(owner.customerId, {
      idempotencyKey: "key-read-1",
      shippingAddressId: owner.shippingAddressId,
      billingAddressId: owner.billingAddressId,
    });

    const mine = await orderService.getMine(owner.customerId, order.id);
    expect(mine.id).toBe(order.id);

    await expect(orderService.getMine(intruder.customerId, order.id)).rejects.toThrow(
      /no encontrada/i,
    );
  });
});

describe("Order service — status transitions", () => {
  const seedOrder = async (key: string) => {
    const { customerId, shippingAddressId, billingAddressId } = await makeCustomer();
    const { product, variant } = await makeProduct(100000, 10);
    await seedCart(customerId, [{ product, variant, qty: 2 }]);
    const { order } = await orderService.createOrder(customerId, {
      idempotencyKey: key,
      shippingAddressId,
      billingAddressId,
    });
    return { order, variant };
  };

  it("markPaid moves pending_payment → paid with a history entry", async () => {
    const { order } = await seedOrder("key-paid-1");
    const paid = await orderService.markPaid(order.id, "admin-1", "pi_test_123");
    expect(paid.status).toBe(OrderStatus.Paid);
    expect(paid.payment.status).toBe(PaymentStatus.Paid);
    expect(paid.payment.ref).toBe("pi_test_123");
    expect(paid.statusHistory).toHaveLength(1);
    expect(paid.statusHistory[0]!.from).toBe(OrderStatus.PendingPayment);
    expect(paid.statusHistory[0]!.to).toBe(OrderStatus.Paid);
  });

  it("advance walks the fulfilment path but rejects an illegal jump", async () => {
    const { order } = await seedOrder("key-advance-1");
    // Illegal: pending_payment → delivered directly.
    await expect(
      orderService.advance(order.id, OrderStatus.Delivered, "admin-1"),
    ).rejects.toThrow(/no permitida/i);

    await orderService.markPaid(order.id, "admin-1");
    const processing = await orderService.advance(order.id, OrderStatus.Processing, "admin-1");
    expect(processing.status).toBe(OrderStatus.Processing);
    const shipped = await orderService.advance(order.id, OrderStatus.Shipped, "admin-1");
    expect(shipped.status).toBe(OrderStatus.Shipped);
    const delivered = await orderService.advance(order.id, OrderStatus.Delivered, "admin-1");
    expect(delivered.status).toBe(OrderStatus.Delivered);
    expect(delivered.statusHistory).toHaveLength(4);
  });

  it("cancel releases the stock reservation", async () => {
    const { order, variant } = await seedOrder("key-cancel-1");
    const beforeVariant = await ProductVariant.findById(variant.id);
    expect(beforeVariant!.reserved).toBe(2);

    const cancelled = await orderService.cancel(order.id, "Cliente se arrepintió", "admin-1");
    expect(cancelled.status).toBe(OrderStatus.Cancelled);

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0);
    const reservation = await StockReservation.findById(order.reservationId);
    expect(reservation!.status).toBe("released");
  });

  it("refund transitions a paid order to refunded and releases the held stock", async () => {
    const { order, variant } = await seedOrder("key-refund-1");
    await orderService.markPaid(order.id, "admin-1");

    const refunded = await orderService.refund(order.id, "Producto defectuoso", "admin-1");
    expect(refunded.status).toBe(OrderStatus.Refunded);
    expect(refunded.payment.status).toBe(PaymentStatus.Refunded);

    const afterVariant = await ProductVariant.findById(variant.id);
    expect(afterVariant!.reserved).toBe(0);
  });

  it("rejects any transition out of a terminal (cancelled) state", async () => {
    const { order } = await seedOrder("key-terminal-1");
    await orderService.cancel(order.id, "motivo", "admin-1");
    await expect(
      orderService.advance(order.id, OrderStatus.Processing, "admin-1"),
    ).rejects.toThrow(/no permitida/i);
  });
});
