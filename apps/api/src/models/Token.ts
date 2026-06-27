import { Schema, model, models, type Document, type Model, type Types } from "mongoose";
import { TokenType, UserType } from "@maria-matera/shared";

/**
 * Single-use, short-lived token for email verification and password reset.
 * Only the SHA-256 hash of the token is stored (never the raw value). The
 * `expiresAt` TTL index lets MongoDB auto-purge expired tokens. The token is
 * deleted as soon as it is consumed.
 */

interface TokenDocument extends Document {
  userId: Types.ObjectId;
  userType: UserType;
  type: TokenType;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const tokenSchema = new Schema<TokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    userType: { type: String, enum: Object.values(UserType), required: true },
    type: { type: String, enum: Object.values(TokenType), required: true },
    tokenHash: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL index: MongoDB removes the document once `expiresAt` passes.
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Token: Model<TokenDocument> =
  (models.Token as Model<TokenDocument>) ?? model<TokenDocument>("Token", tokenSchema);

export type { TokenDocument };
export { Token };
