import { TokenType, UserType } from "@maria-matera/shared";
import { env } from "../config/env.js";
import { Customer, type CustomerDocument } from "../models/Customer.js";
import { Token } from "../models/Token.js";
import { AppError } from "../utils/AppError.js";
import { hashToken, randomToken } from "../utils/token.js";
import type { AuthTokens } from "../utils/cookies.js";
import { emailService } from "./email.service.js";
import { issueSession, revokeAllSessions } from "./session.service.js";

/**
 * Customer authentication: register (+ email verification), login, password
 * reset. Anti-enumeration: login returns a generic error; forgot-password and
 * token consumption never reveal whether an email exists.
 */

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h

interface CustomerDto {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  tier: string;
}

const toCustomerDto = (customer: CustomerDocument): CustomerDto => ({
  id: customer.id as string,
  name: customer.name,
  email: customer.email,
  emailVerified: customer.emailVerified,
  tier: customer.tier,
});

const createSingleUseToken = async (
  userId: string,
  type: TokenType,
  ttlMs: number,
): Promise<string> => {
  const raw = randomToken();
  await Token.create({
    userId,
    userType: UserType.Customer,
    type,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
};

const register = async (input: {
  name: string;
  email: string;
  password: string;
  marketingConsent?: boolean;
}): Promise<CustomerDto> => {
  const existing = await Customer.findOne({ email: input.email });
  if (existing) {
    throw new AppError("El correo ya está registrado.", 409);
  }

  const customer = await Customer.create({
    name: input.name,
    email: input.email,
    password: input.password,
    marketingConsent: input.marketingConsent ?? false,
  });

  const verifyToken = await createSingleUseToken(customer.id, TokenType.VerifyEmail, VERIFY_TTL_MS);
  const verifyUrl = `${env.appUrl}/verificar-correo?token=${verifyToken}`;
  await emailService.sendVerificationEmail(customer.email, verifyUrl);

  return toCustomerDto(customer);
};

const verifyEmail = async (rawToken: string): Promise<void> => {
  const record = await Token.findOne({
    tokenHash: hashToken(rawToken),
    type: TokenType.VerifyEmail,
  });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw new AppError("El enlace de verificación es inválido o expiró.", 400);
  }

  await Customer.findByIdAndUpdate(record.userId, { emailVerified: true });
  await Token.deleteMany({ userId: record.userId, type: TokenType.VerifyEmail });
};

const login = async (
  email: string,
  password: string,
): Promise<{ tokens: AuthTokens; user: CustomerDto }> => {
  const customer = await Customer.findOne({ email }).select("+password");
  if (!customer || !(await customer.comparePassword(password))) {
    throw new AppError("Correo o contraseña incorrectos.", 401);
  }
  if (!customer.emailVerified) {
    throw new AppError("Debes verificar tu correo antes de iniciar sesión.", 403);
  }

  const tokens = await issueSession({ userId: customer.id, userType: UserType.Customer });
  return { tokens, user: toCustomerDto(customer) };
};

const forgotPassword = async (email: string): Promise<void> => {
  const customer = await Customer.findOne({ email });
  // Never reveal whether the email exists: respond success either way.
  if (!customer) {
    return;
  }
  const resetToken = await createSingleUseToken(customer.id, TokenType.ResetPassword, RESET_TTL_MS);
  const resetUrl = `${env.appUrl}/recuperar?token=${resetToken}`;
  await emailService.sendPasswordResetEmail(customer.email, resetUrl);
};

const resetPassword = async (rawToken: string, newPassword: string): Promise<void> => {
  const record = await Token.findOne({
    tokenHash: hashToken(rawToken),
    type: TokenType.ResetPassword,
  });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw new AppError("El enlace para restablecer la contraseña es inválido o expiró.", 400);
  }

  const customer = await Customer.findById(record.userId).select("+password");
  if (!customer) {
    throw new AppError("El enlace para restablecer la contraseña es inválido o expiró.", 400);
  }

  customer.password = newPassword; // pre-save hook re-hashes
  await customer.save();
  await Token.deleteMany({ userId: customer.id, type: TokenType.ResetPassword });
  // Security: invalidate every existing session after a password reset.
  await revokeAllSessions(customer.id);
};

const getProfile = async (customerId: string): Promise<CustomerDto> => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Cuenta no encontrada", 404);
  }
  return toCustomerDto(customer);
};

export type { CustomerDto };
export { register, verifyEmail, login, forgotPassword, resetPassword, getProfile };
