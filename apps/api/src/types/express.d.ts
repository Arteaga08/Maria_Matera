import type { AdminRole, UserType } from "@maria-matera/shared";

/**
 * Express Request augmentation: `protect` attaches the authenticated principal
 * decoded from the access token (no DB hit). Use `req.auth.id` for ownership
 * checks (anti-IDOR).
 */

declare global {
  namespace Express {
    interface Request {
      auth?: {
        id: string;
        userType: UserType;
        role?: AdminRole;
      };
    }
  }
}

export {};
