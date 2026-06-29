import type { UserType } from "@maria-matera/shared";
import { AuditLog } from "../models/AuditLog.js";
import { logger } from "../config/logger.js";

/**
 * Records an admin mutation to the append-only audit trail. Best-effort: a
 * failure to write the audit entry is logged but never breaks the main
 * operation.
 */

interface AuditInput {
  actorId: string;
  actorType: UserType;
  action: string;
  module: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

const recordAudit = async (input: AuditInput): Promise<void> => {
  try {
    await AuditLog.create(input);
  } catch (error) {
    logger.error({ err: error, action: input.action }, "No se pudo registrar auditoría");
  }
};

export type { AuditInput };
export { recordAudit };
