import { randomBytes } from "node:crypto";

/**
 * Certificate serial number. CSPRNG-backed, mirroring the `orderNumber.ts`
 * convention exactly (`randomBytes(6).toString("hex").toUpperCase()`, same
 * entropy, just a different prefix): 6 bytes = 12 hex chars = 48 bits of
 * entropy, e.g. `MM-CERT-A1B2C3D4E5F6`.
 */
const generateCertificateSerial = (): string =>
  `MM-CERT-${randomBytes(6).toString("hex").toUpperCase()}`;

export { generateCertificateSerial };
