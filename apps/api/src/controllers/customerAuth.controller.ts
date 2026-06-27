import type { Request } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendResponse } from "../utils/sendResponse.js";
import { AppError } from "../utils/AppError.js";
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from "../utils/cookies.js";
import * as customerAuth from "../services/customerAuth.service.js";
import { revokeSession, rotateSession } from "../services/session.service.js";

/**
 * Customer auth controllers. Thin: validate (middleware) → service → response.
 * Tokens are set/cleared as HttpOnly cookies; the body never carries them.
 */

const readRefreshCookie = (req: Request): string | undefined =>
  (req.cookies as Record<string, string | undefined>)?.[REFRESH_COOKIE];

const register = asyncHandler(async (req, res) => {
  const customer = await customerAuth.register(req.body);
  sendResponse({
    res,
    statusCode: 201,
    message: "Cuenta creada. Revisa tu correo para verificarla.",
    data: { customer },
  });
});

const verifyEmail = asyncHandler(async (req, res) => {
  await customerAuth.verifyEmail(req.body.token);
  sendResponse({ res, message: "Correo verificado. Ya puedes iniciar sesión.", data: null });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const { tokens, user } = await customerAuth.login(email, password);
  setAuthCookies(res, tokens);
  sendResponse({ res, message: "Sesión iniciada.", data: { user } });
});

const refresh = asyncHandler(async (req, res) => {
  const current = readRefreshCookie(req);
  if (!current) {
    throw new AppError("No autenticado", 401);
  }
  const tokens = await rotateSession(current);
  setAuthCookies(res, tokens);
  sendResponse({ res, message: "Sesión renovada.", data: null });
});

const logout = asyncHandler(async (req, res) => {
  const current = readRefreshCookie(req);
  if (current) {
    await revokeSession(current);
  }
  clearAuthCookies(res);
  sendResponse({ res, message: "Sesión cerrada.", data: null });
});

const forgotPassword = asyncHandler(async (req, res) => {
  await customerAuth.forgotPassword(req.body.email);
  sendResponse({
    res,
    message: "Si el correo está registrado, enviamos instrucciones para restablecer la contraseña.",
    data: null,
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  await customerAuth.resetPassword(req.body.token, req.body.password);
  sendResponse({
    res,
    message: "Contraseña actualizada. Inicia sesión de nuevo.",
    data: null,
  });
});

const me = asyncHandler(async (req, res) => {
  const user = await customerAuth.getProfile(req.auth!.id);
  sendResponse({ res, message: "Perfil del usuario.", data: { user } });
});

export { register, verifyEmail, login, refresh, logout, forgotPassword, resetPassword, me };
