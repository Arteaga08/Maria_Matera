import { randomBytes } from "node:crypto";

/**
 * Human-facing order reference (distinct from the Mongo `_id`). CSPRNG-backed,
 * mirroring the `token.ts` convention (`randomBytes(...).toString("hex")`), just
 * shorter and prefixed for something that fits on a receipt/email: 6 bytes = 12
 * hex chars = 48 bits of entropy — short, non-sequential, non-guessable.
 */
const generateOrderNumber = (): string =>
  `MM-${randomBytes(6).toString("hex").toUpperCase()}`;

export { generateOrderNumber };
