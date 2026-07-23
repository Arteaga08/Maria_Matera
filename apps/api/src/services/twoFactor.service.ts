import { authenticator } from "otplib";
import { UserType } from "@maria-matera/shared";
import { AdminUser } from "../models/AdminUser.js";
import { AppError } from "../utils/AppError.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { recordAudit } from "./audit.service.js";
import type { Actor } from "../utils/actor.js";

const AUDIT_MODULE = "auth";

/**
 * Audits a 2FA posture change. Never receives the TOTP secret or code — only
 * the action — so no credential material can leak into the append-only trail.
 */
const auditTwoFactor = (actor: Actor, action: string): Promise<void> =>
  recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action,
    module: AUDIT_MODULE,
    targetId: actor.id,
    ip: actor.ip,
  });

/**
 * Admin two-factor authentication (TOTP). The shared secret is encrypted at
 * rest (see `crypto.ts`) so a database leak does not expose usable 2FA secrets.
 * Setup stores the secret as "pending" (enabled=false) until the admin confirms
 * a valid code via `enableTwoFactor`.
 */

const ISSUER = "Maria Matera";

const setupTwoFactor = async (
  actor: Actor,
): Promise<{ secret: string; otpauthUrl: string }> => {
  const admin = await AdminUser.findById(actor.id);
  if (!admin) {
    throw new AppError("Cuenta no encontrada", 404);
  }
  if (admin.twoFactor.enabled) {
    throw new AppError("El 2FA ya está activado.", 409);
  }

  const secret = authenticator.generateSecret();
  admin.twoFactor.secret = encryptSecret(secret);
  admin.twoFactor.enabled = false;
  await admin.save();

  await auditTwoFactor(actor, "SETUP_2FA");
  const otpauthUrl = authenticator.keyuri(admin.email, ISSUER, secret);
  return { secret, otpauthUrl };
};

const enableTwoFactor = async (actor: Actor, totp: string): Promise<void> => {
  const admin = await AdminUser.findById(actor.id).select("+twoFactor.secret");
  if (!admin || !admin.twoFactor.secret) {
    throw new AppError("Primero genera la configuración de 2FA.", 400);
  }
  if (admin.twoFactor.enabled) {
    throw new AppError("El 2FA ya está activado.", 409);
  }
  if (!authenticator.verify({ token: totp, secret: decryptSecret(admin.twoFactor.secret) })) {
    throw new AppError("Código de verificación incorrecto.", 401);
  }

  admin.twoFactor.enabled = true;
  await admin.save();
  await auditTwoFactor(actor, "ENABLE_2FA");
};

const disableTwoFactor = async (actor: Actor, totp: string): Promise<void> => {
  const admin = await AdminUser.findById(actor.id).select("+twoFactor.secret");
  if (!admin || !admin.twoFactor.enabled || !admin.twoFactor.secret) {
    throw new AppError("El 2FA no está activado.", 400);
  }
  if (!authenticator.verify({ token: totp, secret: decryptSecret(admin.twoFactor.secret) })) {
    throw new AppError("Código de verificación incorrecto.", 401);
  }

  admin.twoFactor.enabled = false;
  admin.twoFactor.secret = undefined;
  await admin.save();
  await auditTwoFactor(actor, "DISABLE_2FA");
};

const verifyAdminTotp = (encryptedSecret: string, totp: string): boolean =>
  authenticator.verify({ token: totp, secret: decryptSecret(encryptedSecret) });

export { setupTwoFactor, enableTwoFactor, disableTwoFactor, verifyAdminTotp };
