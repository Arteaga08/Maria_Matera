import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { env } from "./env.js";

/**
 * Email transport. Uses Gmail via Nodemailer when credentials are present
 * (`family: 4` forces IPv4 to avoid ECONNREFUSED ::1). When unconfigured
 * (dev/test) callers fall back to logging — see `email.service.ts`.
 */

let transporter: Transporter | null = null;

const isEmailConfigured = (): boolean =>
  Boolean(env.email.user && env.email.pass && env.email.from);

const getTransporter = (): Transporter => {
  if (!transporter) {
    // `family: 4` forces IPv4 (valid at runtime; not in the typings, hence the cast).
    const options = {
      service: "gmail",
      auth: { user: env.email.user, pass: env.email.pass },
      family: 4,
    } as SMTPTransport.Options;
    transporter = nodemailer.createTransport(options);
  }
  return transporter;
};

export { isEmailConfigured, getTransporter };
