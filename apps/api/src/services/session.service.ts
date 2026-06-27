import { type AdminRole, UserType } from "@maria-matera/shared";
import { env } from "../config/env.js";
import { AdminUser } from "../models/AdminUser.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { AppError } from "../utils/AppError.js";
import { generateAccessToken, hashToken, randomToken } from "../utils/token.js";
import type { AuthTokens } from "../utils/cookies.js";

/**
 * Session lifecycle shared by customer and admin auth: issue tokens, rotate the
 * refresh token on each use (the old one is revoked), and revoke one or all
 * sessions. Refresh tokens are opaque CSPRNG strings stored only as a hash.
 */

interface IssueSessionInput {
  userId: string;
  userType: UserType;
  role?: AdminRole;
}

const refreshExpiry = (): Date =>
  new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

const issueSession = async ({ userId, userType, role }: IssueSessionInput): Promise<AuthTokens> => {
  const accessToken = generateAccessToken({ sub: userId, userType, role });
  const refreshToken = randomToken();
  await RefreshToken.create({
    userId,
    userType,
    tokenHash: hashToken(refreshToken),
    expiresAt: refreshExpiry(),
  });
  return { accessToken, refreshToken };
};

const rotateSession = async (rawRefreshToken: string): Promise<AuthTokens> => {
  const record = await RefreshToken.findOne({ tokenHash: hashToken(rawRefreshToken) });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    if (record) {
      await record.deleteOne();
    }
    throw new AppError("Sesión inválida o expirada", 401);
  }

  // Rotation: the presented refresh token is single-use.
  await record.deleteOne();

  let role: AdminRole | undefined;
  if (record.userType === UserType.Admin) {
    const admin = await AdminUser.findById(record.userId);
    if (!admin) {
      throw new AppError("Sesión inválida o expirada", 401);
    }
    role = admin.role;
  }

  return issueSession({ userId: record.userId.toString(), userType: record.userType, role });
};

const revokeSession = async (rawRefreshToken: string): Promise<void> => {
  await RefreshToken.deleteOne({ tokenHash: hashToken(rawRefreshToken) });
};

const revokeAllSessions = async (userId: string): Promise<void> => {
  await RefreshToken.deleteMany({ userId });
};

export { issueSession, rotateSession, revokeSession, revokeAllSessions };
