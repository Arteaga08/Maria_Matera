import { UserType } from "@maria-matera/shared";
import { AdminUser, type AdminUserDocument } from "../models/AdminUser.js";
import { AppError } from "../utils/AppError.js";
import type { AuthTokens } from "../utils/cookies.js";
import { logger } from "../config/logger.js";
import { issueSession } from "./session.service.js";
import { recordAudit } from "./audit.service.js";
import { verifyAdminTotp } from "./twoFactor.service.js";

const AUDIT_MODULE = "auth";

/**
 * Admin authentication. Same anti-enumeration generic error as customer login.
 * When 2FA is enabled, a valid TOTP code is required in addition to the password.
 */

interface AdminDto {
  id: string;
  username: string;
  email: string;
  role: string;
}

const toAdminDto = (admin: AdminUserDocument): AdminDto => ({
  id: admin.id as string,
  username: admin.username,
  email: admin.email,
  role: admin.role,
});

const login = async (
  email: string,
  password: string,
  totp?: string,
  ip?: string,
): Promise<{ tokens: AuthTokens; user: AdminDto }> => {
  const admin = await AdminUser.findOne({ email }).select("+password +twoFactor.secret");
  if (!admin || !(await admin.comparePassword(password))) {
    // Failed logins can't be audited (an unknown email has no actor id, and
    // the AuditLog is an append-only trail of actor-scoped mutations). They
    // go to the structured security log instead — pino already redacts PII —
    // for brute-force monitoring. The loginLimiter caps the attack surface.
    logger.warn({ event: "admin_login_failed", email, ip }, "Intento de login admin fallido");
    throw new AppError("Correo o contraseña incorrectos.", 401);
  }

  if (admin.twoFactor.enabled) {
    if (!totp) {
      throw new AppError("Se requiere el código de verificación de dos pasos.", 401);
    }
    if (!admin.twoFactor.secret || !verifyAdminTotp(admin.twoFactor.secret, totp)) {
      logger.warn({ event: "admin_login_failed_2fa", email, ip }, "Login admin: 2FA inválido");
      throw new AppError("Código de verificación incorrecto.", 401);
    }
  }

  const tokens = await issueSession({
    userId: admin.id,
    userType: UserType.Admin,
    role: admin.role,
  });
  await recordAudit({
    actorId: admin.id as string,
    actorType: UserType.Admin,
    action: "ADMIN_LOGIN",
    module: AUDIT_MODULE,
    targetId: admin.id as string,
    ip,
  });
  return { tokens, user: toAdminDto(admin) };
};

const getProfile = async (adminId: string): Promise<AdminDto> => {
  const admin = await AdminUser.findById(adminId);
  if (!admin) {
    throw new AppError("Cuenta no encontrada", 404);
  }
  return toAdminDto(admin);
};

export type { AdminDto };
export { login, getProfile };
