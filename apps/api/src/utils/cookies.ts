import type { CookieOptions, Response } from "express";
import { env } from "../config/env.js";

/**
 * Auth cookie helpers. Both tokens live in HttpOnly + SameSite=strict cookies
 * (secure in production). The refresh cookie is scoped to the auth router path
 * so it is never sent to unrelated endpoints.
 */

const ACCESS_COOKIE = "accessToken";
const REFRESH_COOKIE = "refreshToken";

const DEFAULT_REFRESH_PATH = "/api/v1/auth";

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: "strict",
});

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const setAuthCookies = (
  res: Response,
  { accessToken, refreshToken }: AuthTokens,
  refreshPath: string = DEFAULT_REFRESH_PATH,
): void => {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    path: "/",
    maxAge: env.accessTokenTtlMin * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    path: refreshPath,
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
};

const clearAuthCookies = (res: Response, refreshPath: string = DEFAULT_REFRESH_PATH): void => {
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions(), path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(), path: refreshPath });
};

export type { AuthTokens };
export { ACCESS_COOKIE, REFRESH_COOKIE, DEFAULT_REFRESH_PATH, setAuthCookies, clearAuthCookies };
