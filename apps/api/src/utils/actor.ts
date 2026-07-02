import type { Request } from "express";

/**
 * The authenticated admin performing an audited mutation. Built from `req.auth`
 * (set by `protect`) plus the request IP.
 */

interface Actor {
  id: string;
  ip?: string;
}

const getActor = (req: Request): Actor => ({ id: req.auth!.id, ip: req.ip });

export type { Actor };
export { getActor };
