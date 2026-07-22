import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { Customer } from "../../models/Customer.js";
import type { OrderDocument } from "../../models/Order.js";
import { issueForOrder } from "../certificate.service.js";
import { emailService } from "../email.service.js";
import { notifyOwner } from "./telegram.js";

/**
 * Centralized despachador of payment-success side effects (Milestone 9).
 *
 * `applyTransition` (`order.service.ts`) fires this fire-and-forget right
 * after committing the `paid` transaction (`void dispatchPaidSideEffects(order)
 * .catch(...)`), so it runs OUTSIDE that Mongo transaction and must NEVER
 * throw back to its caller — a throw here would surface as an unhandled
 * rejection on a webhook ACK path that must stay 200 regardless (see
 * `markPaidInternal`'s doc comment). Each effect therefore gets its own
 * try/catch and failures are only logged, mirroring `certificateService
 * .issueForOrder`'s own per-item isolation.
 *
 * Effects run in this order, not in parallel: certificate issuance completes
 * BEFORE the confirmation email is sent, so the email's "your certificates
 * are already in your account" line is always true by the time it lands.
 */

const buildOwnerAlert = (order: OrderDocument): string => {
  const total = (order.totalCents / 100).toFixed(2);
  return (
    `🛒 Nueva orden pagada: *${order.orderNumber}* — $${total} ${order.currency} ` +
    `(${order.items.length} artículo(s)).`
  );
};

const dispatchPaidSideEffects = async (order: OrderDocument): Promise<void> => {
  try {
    await issueForOrder(order);
  } catch (error) {
    logger.error(
      { err: error, orderId: order.id as string },
      "Fallo al emitir certificados de la orden pagada.",
    );
  }

  try {
    const customer = await Customer.findById(order.customerId).select("email");
    if (!customer?.email) {
      logger.warn(
        { orderId: order.id as string },
        "Orden pagada sin cliente/email para el correo de confirmación.",
      );
    } else {
      await emailService.sendOrderConfirmationEmail(customer.email, {
        orderNumber: order.orderNumber,
        items: order.items.map((item) => ({ name: item.name, qty: item.qty })),
        totalCents: order.totalCents,
        currency: order.currency,
        accountOrdersUrl: `${env.appUrl}/cuenta/pedidos`,
      });
    }
  } catch (error) {
    logger.error(
      { err: error, orderId: order.id as string },
      "Fallo al enviar el correo de confirmación de la orden pagada.",
    );
  }

  try {
    await notifyOwner(buildOwnerAlert(order));
  } catch (error) {
    logger.error(
      { err: error, orderId: order.id as string },
      "Fallo al notificar al dueño de la orden pagada.",
    );
  }
};

export { dispatchPaidSideEffects };
