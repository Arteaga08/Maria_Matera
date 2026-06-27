import { authenticator } from "otplib";
import { AdminUser } from "../models/AdminUser.js";
import { AppError } from "../utils/AppError.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";

/**
 * Admin two-factor authentication (TOTP). The shared secret is encrypted at
 * rest (see `crypto.ts`) so a database leak does not expose usable 2FA secrets.
 * Setup stores the secret as "pending" (enabled=false) until the admin confirms
 * a valid code via `enableTwoFactor`.
 */

const ISSUER = "Maria Matera";

const setupTwoFactor = async (
  adminId: string,
): Promise<{ secret: string; otpauthUrl: string }> => {
  const admin = await AdminUser.findById(adminId);
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

  const otpauthUrl = authenticator.keyuri(admin.email, ISSUER, secret);
  return { secret, otpauthUrl };
};

const enableTwoFactor = async (adminId: string, totp: string): Promise<void> => {
  const admin = await AdminUser.findById(adminId).select("+twoFactor.secret");
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
};

const disableTwoFactor = async (adminId: string, totp: string): Promise<void> => {
  const admin = await AdminUser.findById(adminId).select("+twoFactor.secret");
  if (!admin || !admin.twoFactor.enabled || !admin.twoFactor.secret) {
    throw new AppError("El 2FA no está activado.", 400);
  }
  if (!authenticator.verify({ token: totp, secret: decryptSecret(admin.twoFactor.secret) })) {
    throw new AppError("Código de verificación incorrecto.", 401);
  }

  admin.twoFactor.enabled = false;
  admin.twoFactor.secret = undefined;
  await admin.save();
};

const verifyAdminTotp = (encryptedSecret: string, totp: string): boolean =>
  authenticator.verify({ token: totp, secret: decryptSecret(encryptedSecret) });

export { setupTwoFactor, enableTwoFactor, disableTwoFactor, verifyAdminTotp };
