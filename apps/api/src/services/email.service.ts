import type { Carrier, Currency } from "@maria-matera/shared";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { isEmailConfigured, getTransporter } from "../config/email.js";

/**
 * Transactional + marketing email. Uses the Gmail transport when configured;
 * otherwise (dev/test) it just logs, so flows are testable without credentials.
 * Templates are intentionally simple here — editorial polish comes with the
 * frontend work.
 */

interface CouponEmailData {
  code: string;
  description: string;
}

interface ShippedEmailData {
  orderNumber: string;
  carrier: Carrier;
  trackingNumber: string;
  trackingUrl?: string;
}

interface OrderConfirmationItem {
  name: string;
  qty: number;
}

interface OrderConfirmationEmailData {
  orderNumber: string;
  items: OrderConfirmationItem[];
  totalCents: number;
  currency: Currency;
  accountOrdersUrl: string;
}

interface EmailService {
  sendVerificationEmail(to: string, verifyUrl: string): Promise<void>;
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>;
  sendSubscriptionConfirmation(to: string, confirmUrl: string): Promise<void>;
  sendCouponEmail(to: string, coupon: CouponEmailData, unsubscribeUrl: string): Promise<void>;
  sendShippedEmail(to: string, data: ShippedEmailData): Promise<void>;
  sendOrderConfirmationEmail(to: string, data: OrderConfirmationEmailData): Promise<void>;
}

const formatMoney = (cents: number, currency: Currency): string =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency }).format(cents / 100);

// Templates here are plain string interpolation (no auto-escaping engine — see
// the file header). Any admin/staff-authored free text embedded in an email
// (coupon description, product name) MUST go through this before interpolation,
// since a lower-privileged Editor account could otherwise inject markup that
// executes in a real subscriber's/customer's mail client.
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const send = async (to: string, subject: string, html: string): Promise<void> => {
  if (!isEmailConfigured()) {
    logger.info({ to, subject }, "[email:dev] (no enviado — sin credenciales)");
    return;
  }
  await getTransporter().sendMail({ from: env.email.from, to, subject, html });
};

const emailService: EmailService = {
  sendVerificationEmail: (to, verifyUrl) =>
    send(
      to,
      "Verifica tu correo — Maria Matera",
      `<p>Gracias por crear tu cuenta. Confirma tu correo:</p>
       <p><a href="${verifyUrl}">Verificar mi correo</a></p>`,
    ),

  sendPasswordResetEmail: (to, resetUrl) =>
    send(
      to,
      "Restablece tu contraseña — Maria Matera",
      `<p>Recibimos una solicitud para restablecer tu contraseña:</p>
       <p><a href="${resetUrl}">Crear una nueva contraseña</a></p>
       <p>Si no fuiste tú, ignora este mensaje.</p>`,
    ),

  sendSubscriptionConfirmation: (to, confirmUrl) =>
    send(
      to,
      "Confirma tu suscripción — Maria Matera",
      `<p>Confirma que deseas recibir nuestras novedades y promociones:</p>
       <p><a href="${confirmUrl}">Confirmar suscripción</a></p>`,
    ),

  sendCouponEmail: (to, coupon, unsubscribeUrl) =>
    send(
      to,
      `Tu cupón ${coupon.code} — Maria Matera`,
      `<p>${escapeHtml(coupon.description)}</p>
       <p>Usa el código <strong>${coupon.code}</strong> en tu compra.</p>
       <hr />
       <p style="font-size:12px;color:#888">
         ¿No deseas recibir estos correos?
         <a href="${unsubscribeUrl}">Darte de baja</a>.
       </p>`,
    ),

  sendShippedEmail: (to, data) =>
    send(
      to,
      `Tu pedido ${data.orderNumber} ya va en camino`,
      `<p>¡Buenas noticias! Tu pedido <strong>${data.orderNumber}</strong> ya fue enviado.</p>
       <p>Paquetería: <strong>${data.carrier.toUpperCase()}</strong></p>
       <p>Número de guía: <strong>${data.trackingNumber}</strong></p>
       ${
         data.trackingUrl
           ? `<p><a href="${data.trackingUrl}">Rastrear mi pedido</a></p>`
           : ""
       }`,
    ),

  sendOrderConfirmationEmail: (to, data) =>
    send(
      to,
      `Confirmación de tu pedido ${data.orderNumber} — Maria Matera`,
      `<p>¡Gracias por tu compra! Confirmamos tu pedido <strong>${data.orderNumber}</strong>.</p>
       <ul>
         ${data.items
           .map((item) => `<li>${escapeHtml(item.name)} × ${item.qty}</li>`)
           .join("\n         ")}
       </ul>
       <p>Total: <strong>${formatMoney(data.totalCents, data.currency)}</strong></p>
       <p>Tus certificados de autenticidad ya están disponibles en tu cuenta.</p>
       <p><a href="${data.accountOrdersUrl}">Ver mis pedidos y certificados</a></p>`,
    ),
};

export type {
  EmailService,
  CouponEmailData,
  ShippedEmailData,
  OrderConfirmationItem,
  OrderConfirmationEmailData,
};
export { emailService };
