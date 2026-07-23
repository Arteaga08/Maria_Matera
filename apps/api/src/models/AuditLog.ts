import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { UserType } from "@maria-matera/shared";

/**
 * Append-only audit trail of admin mutations. Captures who did what to which
 * resource, with optional before/after snapshots and the request IP. Never
 * store PII or secrets in the snapshots.
 */

interface AuditLogDocument extends Document {
  actorId: Types.ObjectId;
  actorType: UserType;
  action: string;
  module: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    actorId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorType: { type: String, enum: Object.values(UserType), required: true },
    action: { type: String, required: true },
    module: { type: String, required: true, index: true },
    targetId: { type: String },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Backs the dashboard's global newest-first listing.
auditLogSchema.index({ createdAt: -1 });

const AuditLog: Model<AuditLogDocument> =
  (models.AuditLog as Model<AuditLogDocument>) ??
  model<AuditLogDocument>("AuditLog", auditLogSchema);

export type { AuditLogDocument };
export { AuditLog };
