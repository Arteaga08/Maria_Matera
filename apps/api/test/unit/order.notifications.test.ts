import { beforeEach, describe, expect, it, vi } from "vitest";
import { Currency } from "@maria-matera/shared";

/**
 * `dispatchPaidSideEffects` (Milestone 9). This is the despachador wired into
 * `applyTransition`'s `paid` block: it must run certificate issuance, the
 * order-confirmation email, and the owner Telegram alert as three
 * independent, best-effort steps — a throw from any one of them must NEVER
 * stop the others nor propagate to the caller (the caller is a fire-and-forget
 * `void ...catch()` off the payment transaction, so a throw here would be an
 * unhandled rejection).
 */

const issueForOrderMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/certificate.service.js", () => ({
  issueForOrder: issueForOrderMock,
}));

const sendOrderConfirmationEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/email.service.js", () => ({
  emailService: { sendOrderConfirmationEmail: sendOrderConfirmationEmailMock },
}));

const notifyOwnerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/notification/telegram.js", () => ({
  notifyOwner: notifyOwnerMock,
}));

const findByIdMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/models/Customer.js", () => ({
  Customer: { findById: findByIdMock },
}));

import { dispatchPaidSideEffects } from "../../src/services/notification/order.notifications.js";

const buildOrder = () =>
  ({
    id: "order-1",
    orderNumber: "MM-ABC123456789",
    customerId: "customer-1",
    items: [
      { name: "Anillo Solitario", qty: 1 },
      { name: "Arracadas de Perla", qty: 2 },
    ],
    totalCents: 350000,
    currency: Currency.Mxn,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const selectResolves = (value: unknown) => ({ select: vi.fn().mockResolvedValue(value) });

describe("dispatchPaidSideEffects", () => {
  beforeEach(() => {
    issueForOrderMock.mockReset().mockResolvedValue(undefined);
    sendOrderConfirmationEmailMock.mockReset().mockResolvedValue(undefined);
    notifyOwnerMock.mockReset().mockResolvedValue(undefined);
    findByIdMock.mockReset();
    findByIdMock.mockReturnValue(selectResolves({ email: "cliente@test.com" }));
  });

  it("issues certificates, then emails the customer, then alerts the owner", async () => {
    const order = buildOrder();
    await dispatchPaidSideEffects(order);

    expect(issueForOrderMock).toHaveBeenCalledWith(order);
    expect(sendOrderConfirmationEmailMock).toHaveBeenCalledWith(
      "cliente@test.com",
      expect.objectContaining({
        orderNumber: "MM-ABC123456789",
        totalCents: 350000,
        currency: Currency.Mxn,
        items: [
          { name: "Anillo Solitario", qty: 1 },
          { name: "Arracadas de Perla", qty: 2 },
        ],
      }),
    );
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnerMock.mock.calls[0]![0]).toContain("MM-ABC123456789");

    const issueOrder = issueForOrderMock.mock.invocationCallOrder[0]!;
    const emailOrder = sendOrderConfirmationEmailMock.mock.invocationCallOrder[0]!;
    const notifyOrder = notifyOwnerMock.mock.invocationCallOrder[0]!;
    expect(issueOrder).toBeLessThan(emailOrder);
    expect(emailOrder).toBeLessThan(notifyOrder);
  });

  it("skips the confirmation email (but still alerts the owner) when the customer has no email on file", async () => {
    findByIdMock.mockReturnValue(selectResolves(null));
    await dispatchPaidSideEffects(buildOrder());

    expect(sendOrderConfirmationEmailMock).not.toHaveBeenCalled();
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("still emails the customer and alerts the owner when certificate issuance throws", async () => {
    issueForOrderMock.mockRejectedValue(new Error("cloudinary down"));
    await dispatchPaidSideEffects(buildOrder());

    expect(sendOrderConfirmationEmailMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("still alerts the owner when the confirmation email throws", async () => {
    sendOrderConfirmationEmailMock.mockRejectedValue(new Error("smtp down"));
    await dispatchPaidSideEffects(buildOrder());

    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when every side effect fails", async () => {
    issueForOrderMock.mockRejectedValue(new Error("a"));
    sendOrderConfirmationEmailMock.mockRejectedValue(new Error("b"));
    notifyOwnerMock.mockRejectedValue(new Error("c"));

    await expect(dispatchPaidSideEffects(buildOrder())).resolves.toBeUndefined();
  });
});
