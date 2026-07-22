import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { CustomerTier } from "@maria-matera/shared";

/**
 * Wiring test (Milestone 9): `applyTransition`'s `paid` block must fire
 * `dispatchPaidSideEffects` exactly once per genuine `→ paid` transition,
 * regardless of which entry point drives it (`markPaid` here stands in for
 * `markPaidByPaymentRef`/reconciliation too, since they all share
 * `markPaidInternal` → `applyTransition`). Re-marking an already-`paid` order
 * must NOT re-dispatch — `markPaidInternal` short-circuits before ever
 * reaching `applyTransition` again.
 *
 * `dispatchPaidSideEffects` itself is mocked at its module boundary: its own
 * internal behavior (certificates/email/Telegram, best-effort isolation) is
 * covered by `test/unit/order.notifications.test.ts`. This file only proves
 * the wiring: is it called, with the right order, exactly once.
 */

const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

const dispatchPaidSideEffectsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/notification/order.notifications.js", () => ({
  dispatchPaidSideEffects: dispatchPaidSideEffectsMock,
}));

import { Customer } from "../../src/models/Customer.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import * as orderService from "../../src/services/order.service.js";

let counter = 0;
let piSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.retrievePaymentIntent.mockReset();
  dispatchPaidSideEffectsMock.mockClear();
  stripeMock.createPaymentIntent.mockImplementation(async () => {
    piSeq += 1;
    return { ref: `pi_mock_${piSeq}`, clientSecret: `cs_mock_${piSeq}` };
  });
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

const seedOrder = async (key: string) => {
  counter += 1;
  const customer = await Customer.create({
    name: "Cliente",
    email: `paid-dispatch-${counter}@test.com`,
    password: "Password123",
    tier: CustomerTier.Standard,
    addresses: [address({ label: "Envío" }), address({ label: "Facturación" })],
  });
  const product = await Product.create({
    name: `Anillo ${counter}`,
    slug: `anillo-dispatch-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 100000,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-DISPATCH-${counter}`,
    onHand: 10,
  });
  await Cart.create({
    customerId: customer.id,
    items: [{ productId: product._id, variantId: variant._id, sku: variant.sku, qty: 1 }],
  });
  const { order } = await orderService.createOrder(customer.id as string, {
    idempotencyKey: key,
    shippingAddressId: customer.addresses[0]!._id.toString(),
    billingAddressId: customer.addresses[1]!._id.toString(),
  });
  return order;
};

describe("applyTransition → paid dispatches side effects exactly once", () => {
  it("fires dispatchPaidSideEffects with the paid order on a genuine transition", async () => {
    const order = await seedOrder("dispatch-key-1");
    const paid = await orderService.markPaid(order.id, "admin-1", "pi_test_1");

    expect(dispatchPaidSideEffectsMock).toHaveBeenCalledTimes(1);
    const dispatched = dispatchPaidSideEffectsMock.mock.calls[0]![0] as { id: string };
    expect(dispatched.id).toBe(paid.id);
  });

  it("does NOT re-dispatch when marking an already-paid order paid again", async () => {
    const order = await seedOrder("dispatch-key-2");
    await orderService.markPaid(order.id, "admin-1", "pi_test_2");
    expect(dispatchPaidSideEffectsMock).toHaveBeenCalledTimes(1);

    // Same underlying path webhooks use for a duplicate/retried event.
    await orderService.markPaidByPaymentRef("pi_test_2");
    expect(dispatchPaidSideEffectsMock).toHaveBeenCalledTimes(1);
  });
});
