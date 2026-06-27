import type { Request } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { AppError } from "../utils/AppError.js";
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from "../utils/cookies.js";
import * as adminAuth from "../services/adminAuth.service.js";
import { revokeSession, rotateSession } from "../services/session.service.js";

/**
 * Admin auth controllers. The refresh cookie is scoped to the admin auth path
 * so it is isolated from the storefront session.
 */

const ADMIN_REFRESH_PATH = "/api/v1/admin/auth";

const readRefreshCookie = (req: Request): string | undefined =>
  (req.cookies as Record<string, string | undefined>)?.[REFRESH_COOKIE];

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const { tokens, user } = await adminAuth.login(email, password);
  setAuthCookies(res, tokens, ADMIN_REFRESH_PATH);
  sendResponse({ res, message: "Sesión iniciada.", data: { user } });
});

const refresh = asyncHandler(async (req, res) => {
  const current = readRefreshCookie(req);
  if (!current) {
    throw new AppError("No autenticado", 401);
  }
  const tokens = await rotateSession(current);
  setAuthCookies(res, tokens, ADMIN_REFRESH_PATH);
  sendResponse({ res, message: "Sesión renovada.", data: null });
});

const logout = asyncHandler(async (req, res) => {
  const current = readRefreshCookie(req);
  if (current) {
    await revokeSession(current);
  }
  clearAuthCookies(res, ADMIN_REFRESH_PATH);
  sendResponse({ res, message: "Sesión cerrada.", data: null });
});

const me = asyncHandler(async (req, res) => {
  const user = await adminAuth.getProfile(req.auth!.id);
  sendResponse({ res, message: "Perfil del administrador.", data: { user } });
});

export { login, refresh, logout, me };
