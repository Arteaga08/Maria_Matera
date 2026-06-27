import { Schema, model, models, type Document, type Model } from "mongoose";
import bcrypt from "bcryptjs";
import { AdminRole } from "@maria-matera/shared";

/**
 * Admin/staff account (dashboard). Same password hardening as Customer. The
 * `twoFactor.secret` holds the TOTP secret ENCRYPTED at rest (set in Paso 1b);
 * it is `select: false` and never returned.
 */

const BCRYPT_ROUNDS = 12;

interface TwoFactor {
  enabled: boolean;
  secret?: string;
}

interface AdminUserDocument extends Document {
  username: string;
  email: string;
  password: string;
  role: AdminRole;
  twoFactor: TwoFactor;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const adminUserSchema = new Schema<AdminUserDocument>(
  {
    username: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(AdminRole), default: AdminRole.Admin },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secret: { type: String, select: false },
    },
  },
  { timestamps: true },
);

adminUserSchema.pre("save", async function hashPassword(next) {
  if (!this.isModified("password")) {
    next();
    return;
  }
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
  next();
});

adminUserSchema.methods.comparePassword = async function comparePassword(
  this: AdminUserDocument,
  candidate: string,
): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

const AdminUser: Model<AdminUserDocument> =
  (models.AdminUser as Model<AdminUserDocument>) ??
  model<AdminUserDocument>("AdminUser", adminUserSchema);

export type { AdminUserDocument, TwoFactor };
export { AdminUser };
