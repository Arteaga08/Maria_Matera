import { logger } from "../config/logger.js";

/**
 * Email service abstraction. The transactional provider (Resend/Postmark) is
 * wired later; for now the dev transport just logs the link so the flow is
 * testable end-to-end without committing to a provider.
 */

interface EmailService {
  sendVerificationEmail(to: string, verifyUrl: string): Promise<void>;
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>;
}

const devEmailService: EmailService = {
  async sendVerificationEmail(to, verifyUrl) {
    logger.info({ to, verifyUrl }, "[email:dev] Verificación de correo");
  },
  async sendPasswordResetEmail(to, resetUrl) {
    logger.info({ to, resetUrl }, "[email:dev] Restablecer contraseña");
  },
};

const emailService: EmailService = devEmailService;

export type { EmailService };
export { emailService };
