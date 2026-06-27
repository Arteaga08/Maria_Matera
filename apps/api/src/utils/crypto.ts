import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Authenticated symmetric encryption (AES-256-GCM) for secrets stored at rest,
 * e.g. the admin TOTP secret. The 32-byte key is derived from ENCRYPTION_KEY.
 * Output format: "ivHex:authTagHex:cipherHex".
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const key = createHash("sha256").update(env.encryptionKey).digest();

const encryptSecret = (plaintext: string): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
};

const decryptSecret = (payload: string): string => {
  const [ivHex, authTagHex, cipherHex] = payload.split(":");
  if (!ivHex || !authTagHex || !cipherHex) {
    throw new Error("Formato de secreto cifrado invalido");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
};

export { encryptSecret, decryptSecret };
