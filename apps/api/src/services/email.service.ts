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

interface EmailService {
  sendVerificationEmail(to: string, verifyUrl: string): Promise<void>;
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>;
  sendSubscriptionConfirmation(to: string, confirmUrl: string): Promise<void>;
  sendCouponEmail(to: string, coupon: CouponEmailData, unsubscribeUrl: string): Promise<void>;
}

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
      `<p>${coupon.description}</p>
       <p>Usa el código <strong>${coupon.code}</strong> en tu compra.</p>
       <hr />
       <p style="font-size:12px;color:#888">
         ¿No deseas recibir estos correos?
         <a href="${unsubscribeUrl}">Darte de baja</a>.
       </p>`,
    ),
};

export type { EmailService, CouponEmailData };
export { emailService };
