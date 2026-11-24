// Refresh-token sessions (docs/contracts/AUTH-FACULTY.md §2.2), ported from
// Matchy's refresh-token model: hash-at-rest, TTL expiry, explicit revocation.
//
// One document per signed-in device/browser. The refresh JWT carries
// `{_id: userId, sid: session._id}`; only its sha256 is stored. Sessions are
// NOT rotated on refresh (several tabs share one cookie and users keep several
// devices signed in), and at most 10 active sessions are kept per user.
import mongoose, { Schema } from "mongoose";

export const AUTH_SESSION_REVOKE_REASONS = Object.freeze([
    "logout",
    "logout_all",
    "password_reset",
    "password_change",
    "admin_reset",
    "deactivated",
    "session_limit",
]);

const AuthSessionSchema = new Schema(
    {
        user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        // sha256 hex of the refresh JWT.
        tokenHash: { type: String, required: true, select: false },
        // Equals the refresh JWT `exp`; MongoDB deletes the document afterwards.
        expiresAt: { type: Date, required: true },
        revokedAt: { type: Date, default: null },
        revokedReason: { type: String, enum: AUTH_SESSION_REVOKE_REASONS },
        lastUsedAt: { type: Date },
        userAgent: { type: String, trim: true, maxlength: 300 },
    },
    {
        timestamps: true,
        collection: "auth_sessions",
    },
);

AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
AuthSessionSchema.index({ user: 1, revokedAt: 1, expiresAt: 1 });

AuthSessionSchema.set("toJSON", {
    transform: (_doc, ret) => {
        delete ret.tokenHash;
        return ret;
    },
});

export const AuthSession = mongoose.models.AuthSession || mongoose.model("AuthSession", AuthSessionSchema);
