import xss from "xss";

/**
 * Recursive XSS sanitizer. Escapes HTML/script payloads from every string in a
 * nested structure (objects + arrays), returning a new sanitized value.
 *
 * Credential-like fields are skipped on purpose: HTML-escaping a password would
 * silently alter the secret the user typed. Their integrity is protected by
 * hashing + transport security, not by HTML escaping.
 */

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordConfirm",
  "currentPassword",
  "newPassword",
  "token",
  "refreshToken",
]);

const sanitizeValue = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") {
    return key && SENSITIVE_KEYS.has(key) ? value : xss(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeValue(childValue, childKey);
    }
    return result;
  }
  return value;
};

const deepSanitize = <T>(value: T): T => sanitizeValue(value) as T;

export { deepSanitize };
