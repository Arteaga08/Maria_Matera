import { UserType } from "@maria-matera/shared";
import { AdminUser, type AdminUserDocument } from "../models/AdminUser.js";
import { AppError } from "../utils/AppError.js";
import type { AuthTokens } from "../utils/cookies.js";
import { issueSession } from "./session.service.js";

/**
 * Admin authentication. Same anti-enumeration generic error as customer login.
 * 2FA TOTP gating is added in Paso 1b.
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
): Promise<{ tokens: AuthTokens; user: AdminDto }> => {
  const admin = await AdminUser.findOne({ email }).select("+password");
  if (!admin || !(await admin.comparePassword(password))) {
    throw new AppError("Correo o contraseña incorrectos.", 401);
  }

  const tokens = await issueSession({
    userId: admin.id,
    userType: UserType.Admin,
    role: admin.role,
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
