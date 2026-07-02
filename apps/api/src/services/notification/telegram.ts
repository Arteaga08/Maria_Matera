import axios from "axios";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Internal Telegram alerts to the store owner (new order, low stock, ...).
 * No-op when unconfigured. Failures are logged, never thrown — an alert must
 * never break the operation that triggered it.
 */

const isTelegramConfigured = (): boolean =>
  Boolean(env.telegram.botToken && env.telegram.chatId);

const notifyOwner = async (message: string): Promise<void> => {
  if (!isTelegramConfigured()) {
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${env.telegram.botToken}/sendMessage`, {
      chat_id: env.telegram.chatId,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (error) {
    logger.error({ err: error }, "Fallo la notificación de Telegram");
  }
};

export { notifyOwner, isTelegramConfigured };
