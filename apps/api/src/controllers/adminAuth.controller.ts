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
import * as twoFactor from "../services/twoFactor.service.js";
import { revokeSession, rotateSession } from "../services/session.service.js";

/**
 * Admin auth controllers. The refresh cookie is scoped to the admin auth path
 * so it is isolated from the storefront session.
 */

const ADMIN_REFRESH_PATH = "/api/v1/admin/auth";

const readRefreshCookie = (req: Request): string | undefined =>
  (req.cookies as Record<string, string | undefined>)?.[REFRESH_COOKIE];

const login = asyncHandler(async (req, res) => {
  const { email, password, totp } = req.body;
  const { tokens, user } = await adminAuth.login(email, password, totp);
  setAuthCookies(res, tokens, ADMIN_REFRESH_PATH);
  sendResponse({ res, message: "Sesión iniciada.", data: { user } });
});

const setup2fa = asyncHandler(async (req, res) => {
  const data = await twoFactor.setupTwoFactor(req.auth!.id);
  sendResponse({
    res,
    message: "Escanea el código en tu app de autenticación y confirma con un código.",
    data,
  });
});

const enable2fa = asyncHandler(async (req, res) => {
  await twoFactor.enableTwoFactor(req.auth!.id, req.body.totp);
  sendResponse({ res, message: "Autenticación de dos pasos activada.", data: null });
});

const disable2fa = asyncHandler(async (req, res) => {
  await twoFactor.disableTwoFactor(req.auth!.id, req.body.totp);
  sendResponse({ res, message: "Autenticación de dos pasos desactivada.", data: null });
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

export { login, refresh, logout, me, setup2fa, enable2fa, disable2fa };
