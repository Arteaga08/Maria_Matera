import type { NextFunction, Request, Response } from "express";

/**
 * Recursively strips keys that could drive NoSQL injection or prototype
 * pollution: any key starting with "$" or containing ".", plus the dangerous
 * "__proto__" / "constructor" / "prototype" keys. Objects are mutated in place
 * because in Express 5 `req.query` is read-only and cannot be reassigned.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizeInPlace = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      sanitizeInPlace(item);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes(".") || FORBIDDEN_KEYS.has(key)) {
      delete value[key];
      continue;
    }
    sanitizeInPlace(value[key]);
  }
};

const mongoSanitize = (req: Request, _res: Response, next: NextFunction): void => {
  sanitizeInPlace(req.body);
  sanitizeInPlace(req.params);
  sanitizeInPlace(req.query);
  next();
};

export { mongoSanitize };
