import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { UserType } from "@maria-matera/shared";

/**
 * Server-side record of an issued refresh token, enabling rotation and
 * revocation ("log out all devices"). Only the SHA-256 hash is stored. On
 * refresh, the old record is deleted and a new one created (rotation). The
 * `expiresAt` TTL index auto-purges expired records.
 */

interface RefreshTokenDocument extends Document {
  userId: Types.ObjectId;
  userType: UserType;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    userType: { type: String, enum: Object.values(UserType), required: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL index: MongoDB removes the document once `expiresAt` passes.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshToken: Model<RefreshTokenDocument> =
  (models.RefreshToken as Model<RefreshTokenDocument>) ??
  model<RefreshTokenDocument>("RefreshToken", refreshTokenSchema);

export type { RefreshTokenDocument };
export { RefreshToken };
