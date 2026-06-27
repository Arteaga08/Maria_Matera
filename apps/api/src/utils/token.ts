import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { AdminRole, UserType } from "@maria-matera/shared";
import { env } from "../config/env.js";

/**
 * Token helpers.
 * - Access token: short-lived JWT carried in an HttpOnly cookie.
 * - Refresh token: opaque CSPRNG string, stored only as a SHA-256 hash and
 *   rotated on every use (revocable).
 * - Verification/reset tokens reuse `randomToken` + `hashToken`.
 */

interface AccessTokenPayload {
  sub: string;
  userType: UserType;
  role?: AdminRole;
}

const generateAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.accessTokenTtlMin * 60 });

const verifyAccessToken = (token: string): AccessTokenPayload => {
  const decoded = jwt.verify(token, env.jwtAccessSecret);
  if (typeof decoded === "string" || typeof decoded.sub !== "string" || !("userType" in decoded)) {
    throw new jwt.JsonWebTokenError("Token con formato invalido");
  }
  return {
    sub: decoded.sub,
    userType: decoded.userType as UserType,
    role: decoded.role as AdminRole | undefined,
  };
};

const randomToken = (): string => randomBytes(32).toString("hex");

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export type { AccessTokenPayload };
export { generateAccessToken, verifyAccessToken, randomToken, hashToken };
