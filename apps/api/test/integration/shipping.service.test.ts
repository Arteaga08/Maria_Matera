import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { Carrier, OrderStatus, UserType } from "@maria-matera/shared";

/**
 * Shipping service (Milestone 7, Task 3). Drives real orders through
 * `order.service.ts`'s state machine (Stripe mocked at its module boundary,
 * same pattern as `order.service.test.ts`) and exercises `shipping.service.ts`
 * on top: guide assignment/delivery/edit/revert, the admin read, and the
 * public (PII-free) tracking read.
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
import { Order } from "../../src/models/Order.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import * as orderService from "../../src/services/order.service.js";
import * as shippingService from "../../src/services/shipping.service.js";
import { emailService } from "../../src/services/email.service.js";
import type { Actor } from "../../src/utils/actor.js";

let counter = 0;
let piSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.retrievePaymentIntent.mockReset();
  stripeMock.refund.mockReset();
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

const actor: Actor = { id: new mongoose.Types.ObjectId().toString(), ip: "127.0.0.1" };

const address = (overrides: Record<string, unknown> = {}) => ({
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
  ...overrides,
});

const makeCustomer = async () => {
  counter += 1;
  const customer = await Customer.create({
    name: "Cliente",
    email: `shipping-svc-${counter}@test.com`,
    password: "Password123",
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
    slug: `anillo-shipping-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `RING-SHIP-${counter}`,
    onHand,
  });
  return { product, variant };
};

const seedCart = async (
  customerId: string,
  product: { _id: mongoose.Types.ObjectId },
  variant: { _id: mongoose.Types.ObjectId; sku: string },
  qty: number,
) =>
  Cart.create({
    customerId,
    items: [{ productId: product._id, variantId: variant._id, sku: variant.sku, qty }],
  });

/** Builds a fresh order for `email`, seeded to the given key. */
const seedOrder = async (key: string) => {
  const { customer, customerId, shippingAddressId, billingAddressId } = await makeCustomer();
  const { product, variant } = await makeProduct(100000, 10);
  await seedCart(customerId, product, variant, 2);
  const { order } = await orderService.createOrder(customerId, {
    idempotencyKey: key,
    shippingAddressId,
    billingAddressId,
  });
  return { order, customer };
};

/** Drives an order to `paid`. */
const seedPaidOrder = async (key: string) => {
  const { order, customer } = await seedOrder(key);
  const paid = await orderService.markPaid(order.id, "admin-1");
  return { order: paid, customer };
};

/** Drives an order to `processing`. */
const seedProcessingOrder = async (key: string) => {
  const { order, customer } = await seedPaidOrder(key);
  const processing = await orderService.advance(order.id, OrderStatus.Processing, "admin-1");
  return { order: processing, customer };
};

describe("shipping.service — assignGuide", () => {
  it("transitions Processing → Shipped, sets carrier/trackingNumber/shippedAt atomically, and audits", async () => {
    const { order, customer } = await seedProcessingOrder("key-assign-1");
    const emailSpy = vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();

    const result = await shippingService.assignGuide(
      order.id,
      { carrier: Carrier.Dhl, trackingNumber: "TRACK-100" },
      actor,
      "guía generada",
    );
    expect(result.status).toBe(OrderStatus.Shipped);

    // Re-fetch from the DB to prove the status + shipping fields landed atomically.
    const reloaded = await Order.findById(order.id);
    expect(reloaded!.status).toBe(OrderStatus.Shipped);
    expect(reloaded!.shipping.carrier).toBe(Carrier.Dhl);
    expect(reloaded!.shipping.trackingNumber).toBe("TRACK-100");
    expect(reloaded!.shipping.shippedAt).toBeInstanceOf(Date);

    const audit = await AuditLog.findOne({ action: "ASSIGN_GUIDE", targetId: order.id });
    expect(audit).not.toBeNull();
    expect(audit!.actorType).toBe(UserType.Admin);
    expect(audit!.module).toBe("shipping");

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).toHaveBeenCalledWith(
      customer.email,
      expect.objectContaining({
        orderNumber: reloaded!.orderNumber,
        carrier: Carrier.Dhl,
        trackingNumber: "TRACK-100",
        trackingUrl: expect.stringContaining("TRACK-100"),
      }),
    );

    emailSpy.mockRestore();
  });

  it("still succeeds and returns the shipped order even when the notification email throws (regression guard)", async () => {
    const { order } = await seedProcessingOrder("key-assign-email-fail-1");
    const emailSpy = vi
      .spyOn(emailService, "sendShippedEmail")
      .mockRejectedValue(new Error("SMTP down"));

    const result = await shippingService.assignGuide(order.id, {
      carrier: Carrier.FedEx,
      trackingNumber: "TRACK-200",
    }, actor);

    // The shipment persisted despite the email failure — no state/response mismatch.
    expect(result.status).toBe(OrderStatus.Shipped);
    const reloaded = await Order.findById(order.id);
    expect(reloaded!.status).toBe(OrderStatus.Shipped);
    expect(reloaded!.shipping.trackingNumber).toBe("TRACK-200");

    expect(emailSpy).toHaveBeenCalledTimes(1);
    emailSpy.mockRestore();
  });

  it("propagates the 409 from adminAdvance when the order isn't Processing", async () => {
    const { order } = await seedOrder("key-assign-illegal-1"); // still pending_payment
    const emailSpy = vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();

    await expect(
      shippingService.assignGuide(order.id, { carrier: Carrier.Ups, trackingNumber: "X" }, actor),
    ).rejects.toThrow(/no permitida/i);

    const reloaded = await Order.findById(order.id);
    expect(reloaded!.status).toBe(OrderStatus.PendingPayment);
    expect(reloaded!.shipping.carrier).toBeUndefined();
    expect(emailSpy).not.toHaveBeenCalled();
    emailSpy.mockRestore();
  });
});

describe("shipping.service — markDelivered", () => {
  it("transitions Shipped → Delivered, sets deliveredAt, and leaves carrier/trackingNumber/shippedAt untouched", async () => {
    const { order } = await seedProcessingOrder("key-delivered-1");
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    const shipped = await shippingService.assignGuide(order.id, {
      carrier: Carrier.Estafeta,
      trackingNumber: "TRACK-300",
    }, actor);

    const delivered = await shippingService.markDelivered(shipped.id, actor);
    expect(delivered.status).toBe(OrderStatus.Delivered);

    const reloaded = await Order.findById(shipped.id);
    expect(reloaded!.status).toBe(OrderStatus.Delivered);
    expect(reloaded!.shipping.deliveredAt).toBeInstanceOf(Date);
    // Merge semantics, not reset.
    expect(reloaded!.shipping.carrier).toBe(Carrier.Estafeta);
    expect(reloaded!.shipping.trackingNumber).toBe("TRACK-300");
    expect(reloaded!.shipping.shippedAt).toBeInstanceOf(Date);

    const audit = await AuditLog.findOne({ action: "MARK_DELIVERED", targetId: shipped.id });
    expect(audit).not.toBeNull();

    vi.restoreAllMocks();
  });
});

describe("shipping.service — editGuide", () => {
  it("corrects carrier/trackingNumber WITHOUT changing status, and audits before/after", async () => {
    const { order } = await seedProcessingOrder("key-edit-1");
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    const shipped = await shippingService.assignGuide(order.id, {
      carrier: Carrier.Dhl,
      trackingNumber: "TYPO-1",
    }, actor);

    const edited = await shippingService.editGuide(
      shipped.id,
      { trackingNumber: "CORRECT-1" },
      actor,
      "corrección de guía",
    );
    expect(edited.status).toBe(OrderStatus.Shipped); // unchanged
    expect(edited.shipping.trackingNumber).toBe("CORRECT-1");
    expect(edited.shipping.carrier).toBe(Carrier.Dhl); // untouched (not in input)

    const reloaded = await Order.findById(shipped.id);
    expect(reloaded!.shipping.trackingNumber).toBe("CORRECT-1");

    const audit = await AuditLog.findOne({ action: "EDIT_GUIDE", targetId: shipped.id });
    expect(audit).not.toBeNull();
    expect((audit!.before as { trackingNumber?: string }).trackingNumber).toBe("TYPO-1");
    expect((audit!.after as { trackingNumber?: string }).trackingNumber).toBe("CORRECT-1");

    vi.restoreAllMocks();
  });

  it("applies a partial update — omitted fields stay as they were", async () => {
    const { order } = await seedProcessingOrder("key-edit-partial-1");
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    const shipped = await shippingService.assignGuide(order.id, {
      carrier: Carrier.Ups,
      trackingNumber: "UPS-1",
    }, actor);

    const edited = await shippingService.editGuide(shipped.id, { carrier: Carrier.FedEx }, actor);
    expect(edited.shipping.carrier).toBe(Carrier.FedEx);
    expect(edited.shipping.trackingNumber).toBe("UPS-1"); // untouched

    vi.restoreAllMocks();
  });
});

describe("shipping.service — revertShipment", () => {
  it("transitions Shipped → Processing, clears all shipping fields, and audits the reason", async () => {
    const { order } = await seedProcessingOrder("key-revert-1");
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    const shipped = await shippingService.assignGuide(order.id, {
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-400",
    }, actor);

    const reverted = await shippingService.revertShipment(
      shipped.id,
      "carrier perdió el paquete",
      actor,
    );
    expect(reverted.status).toBe(OrderStatus.Processing);

    const reloaded = await Order.findById(shipped.id);
    expect(reloaded!.status).toBe(OrderStatus.Processing);
    expect(reloaded!.shipping.carrier).toBeUndefined();
    expect(reloaded!.shipping.trackingNumber).toBeUndefined();
    expect(reloaded!.shipping.shippedAt).toBeUndefined();
    expect(reloaded!.shipping.deliveredAt).toBeUndefined();

    const audit = await AuditLog.findOne({ action: "REVERT_SHIPMENT", targetId: shipped.id });
    expect(audit).not.toBeNull();
    expect((audit!.after as { reason?: string }).reason).toBe("carrier perdió el paquete");

    vi.restoreAllMocks();
  });
});

describe("shipping.service — markProcessing", () => {
  it("transitions a Paid order to Processing and audits", async () => {
    const { order } = await seedPaidOrder("key-processing-1");
    const processing = await shippingService.markProcessing(order.id, actor, "inicio de surtido");
    expect(processing.status).toBe(OrderStatus.Processing);

    const audit = await AuditLog.findOne({ action: "MARK_PROCESSING", targetId: order.id });
    expect(audit).not.toBeNull();
  });
});

describe("shipping.service — getShipment", () => {
  it("returns trackingUrl when both carrier and trackingNumber are set", async () => {
    const { order } = await seedProcessingOrder("key-getshipment-1");
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    const shipped = await shippingService.assignGuide(order.id, {
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-500",
    }, actor);

    const view = await shippingService.getShipment(shipped.id);
    expect(view.trackingUrl).toContain("TRACK-500");
    expect(view.order.id).toBe(shipped.id);

    vi.restoreAllMocks();
  });

  it("returns undefined trackingUrl when shipping is not yet set", async () => {
    const { order } = await seedProcessingOrder("key-getshipment-2");
    const view = await shippingService.getShipment(order.id);
    expect(view.trackingUrl).toBeUndefined();
  });
});

describe("shipping.service — publicTrack", () => {
  it("returns a minimal, PII-free payload for an existing tracking number", async () => {
    const { order } = await seedProcessingOrder("key-publictrack-1");
    vi.spyOn(emailService, "sendShippedEmail").mockResolvedValue();
    await shippingService.assignGuide(order.id, {
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-PUBLIC-1",
    }, actor);

    const result = await shippingService.publicTrack("TRACK-PUBLIC-1");
    expect(result).toEqual({
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-PUBLIC-1",
      trackingUrl: expect.stringContaining("TRACK-PUBLIC-1"),
      status: OrderStatus.Shipped,
      shippedAt: expect.any(Date),
      deliveredAt: undefined,
    });

    // Regression guard: this would fail if someone later carelessly widened
    // the payload to include customer/order-identifying data.
    const keys = Object.keys(result);
    expect(keys).not.toContain("customerId");
    expect(keys).not.toContain("orderNumber");
    expect(keys).not.toContain("shippingAddress");
    expect(keys).not.toContain("billingAddress");
    expect(keys).not.toContain("items");
    expect(keys).not.toContain("totalCents");
    expect(keys.sort()).toEqual(
      ["carrier", "deliveredAt", "shippedAt", "status", "trackingNumber", "trackingUrl"].sort(),
    );

    vi.restoreAllMocks();
  });

  it("throws a flat 404 for a non-existent tracking number (anti-enumeration)", async () => {
    await expect(shippingService.publicTrack("DOES-NOT-EXIST")).rejects.toThrow(
      /no encontrada/i,
    );
  });

  it("throws a flat 404 when trackingNumber is set but carrier is not (never leaks an undefined-carrier payload)", async () => {
    const { order } = await seedProcessingOrder("key-publictrack-no-carrier-1");
    // Simulate a doc where `shipping.trackingNumber` is set but `shipping.carrier`
    // never was — bypassing the service layer directly, since no current caller
    // does this, but the schema allows it (both fields are independently
    // optional) and the public read must not trust that combination.
    await Order.updateOne(
      { _id: order.id },
      { $set: { "shipping.trackingNumber": "ORPHAN-TRACK-1" }, $unset: { "shipping.carrier": "" } },
    );

    await expect(shippingService.publicTrack("ORPHAN-TRACK-1")).rejects.toThrow(/no encontrada/i);
  });
});
