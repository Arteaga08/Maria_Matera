import { Types } from "mongoose";
import type { UserType } from "@maria-matera/shared";
import type { PaginationMeta } from "@maria-matera/shared";
import { AdminUser } from "../models/AdminUser.js";
import { AuditLog, type AuditLogDocument } from "../models/AuditLog.js";
import { logger } from "../config/logger.js";
import { parseListQuery, buildMeta } from "../utils/listQuery.js";

/**
 * Records an admin mutation to the append-only audit trail. Best-effort: a
 * failure to write the audit entry is logged but never breaks the main
 * operation. `adminList` is the global read for the dashboard (Admin-only at
 * the route layer) — strictly read-only, the trail is never mutated here.
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

// --- Global admin read (Bloque 2 dashboard) ----------------------------------

interface AuditRow {
  id: string;
  createdAt: Date;
  actorId: string;
  actorType: UserType;
  actorUsername?: string;
  actorEmail?: string;
  action: string;
  module: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

const isObjectIdString = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

const adminList = async (
  query: Record<string, unknown>,
): Promise<{ items: AuditRow[]; meta: PaginationMeta }> => {
  const { page, pageSize, skip, sort } = parseListQuery(query, {
    allowedSort: ["createdAt"],
    defaultSort: "-createdAt",
  });

  const filter: Record<string, unknown> = {};
  if (typeof query.module === "string" && query.module.trim()) {
    filter.module = query.module.trim();
  }
  if (typeof query.action === "string" && query.action.trim()) {
    filter.action = query.action.trim();
  }
  if (isObjectIdString(query.actorId)) {
    filter.actorId = new Types.ObjectId(query.actorId);
  }
  if (typeof query.targetId === "string" && query.targetId.trim()) {
    filter.targetId = query.targetId.trim();
  }
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    filter.createdAt = {
      ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}),
      ...(to && !Number.isNaN(to.getTime()) ? { $lte: to } : {}),
    };
  }

  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort(sort).skip(skip).limit(pageSize).exec(),
    AuditLog.countDocuments(filter),
  ]);

  // Resolve actor identities in one $in fetch (never N+1). Actors that no
  // longer exist (deleted admin) simply stay unresolved — the raw actorId is
  // always present.
  const actorIds = [...new Set(entries.map((e) => e.actorId.toString()))];
  const admins = await AdminUser.find({ _id: { $in: actorIds } })
    .select("username email")
    .exec();
  const adminById = new Map(
    admins.map((a) => [a.id as string, { username: a.username, email: a.email }]),
  );

  const items: AuditRow[] = entries.map((entry: AuditLogDocument) => {
    const actor = adminById.get(entry.actorId.toString());
    return {
      id: entry.id as string,
      createdAt: entry.createdAt,
      actorId: entry.actorId.toString(),
      actorType: entry.actorType,
      actorUsername: actor?.username,
      actorEmail: actor?.email,
      action: entry.action,
      module: entry.module,
      targetId: entry.targetId,
      before: entry.before,
      after: entry.after,
      ip: entry.ip,
    };
  });

  return { items, meta: buildMeta(page, pageSize, total) };
};

export type { AuditInput, AuditRow };
export { recordAudit, adminList };
