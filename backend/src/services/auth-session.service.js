// Refresh-token sessions, auth cookies and access revocation
// (docs/contracts/AUTH-FACULTY.md §3).
//
//   issueSession(user, {userAgent})       → {accessToken, refreshToken, refreshExpiresAt, sessionId}
//   refreshSession(refreshToken)          → {user, accessToken, sessionId}      (no rotation)
//   revokeSession(refreshToken, reason)   → boolean
//   revokeAllSessions(userId, reason, {exceptSessionId}) → number
//   currentSessionId(req)                 → string | null
//   invalidateUserAccess(userId, reason, {exceptSessionId, kick}) → {tokenVersion, revoked}
//   setAuthCookies / clearAuthCookies / authCookieBase
//
// No JSON response ever carries the refresh token: it travels only in the
// httpOnly `refreshToken` cookie scoped to /api/v1/auth.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { AUTH_COOKIE_SAMESITE, NODE_ENV } from "../config/config.js";
import { getIO, emitToUser, rooms } from "../core/realtime.js";
import { AuthSession } from "../models/auth-session.models.js";
import { User, USER_AUTH_PROJECTION } from "../models/user.models.js";
import { ApiError } from "../utils/api-error.js";

export const MAX_ACTIVE_SESSIONS = 10;
export const ACCESS_COOKIE = "accessToken";
export const REFRESH_COOKIE = "refreshToken";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
const KICK_DELAY_MS = 250;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

const apiError = (status, message, code) => new ApiError(status, message, [{ code }]);
const invalidRefresh = () => apiError(401, "Your session has expired. Please sign in again.", "REFRESH_TOKEN_INVALID");
const accountDisabled = () => apiError(403, "This account has been deactivated. Contact your placement office.", "ACCOUNT_DISABLED");

export const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const hashesEqual = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const clipUserAgent = (value) => (typeof value === "string" ? value.slice(0, 300) : undefined);

/** Verified refresh payload `{_id, sid}` or null. */
const verifyRefreshJwt = (refreshToken, { ignoreExpiration = false } = {}) => {
    if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 4096) return null;
    try {
        const payload = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET, { ignoreExpiration, algorithms: ["HS256"] });
        if (!payload || typeof payload !== "object") return null;
        if (typeof payload._id !== "string" || !OBJECT_ID_RE.test(payload._id)) return null;
        if (typeof payload.sid !== "string" || !OBJECT_ID_RE.test(payload.sid)) return null;
        return payload;
    } catch {
        return null;
    }
};

/** Revoke the oldest active sessions beyond the per-user cap. */
const enforceSessionCap = async (userId, now = new Date()) => {
    const extra = await AuthSession.find({ user: userId, revokedAt: null, expiresAt: { $gt: now } })
        .sort({ createdAt: -1, _id: -1 })
        .skip(MAX_ACTIVE_SESSIONS)
        .select("_id")
        .lean();
    if (extra.length === 0) return 0;
    const result = await AuthSession.updateMany(
        { _id: { $in: extra.map((session) => session._id) }, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: "session_limit" } },
    );
    return result.modifiedCount || 0;
};

/**
 * Start a session for a successful login: new AuthSession + refresh JWT bound
 * to it + an access token carrying the user's current tokenVersion.
 */
export const issueSession = async (user, { userAgent } = {}) => {
    const now = new Date();
    const session = new AuthSession({ user: user._id, userAgent: clipUserAgent(userAgent) });
    const refreshToken = user.generateRefreshToken(session._id);
    const { exp } = jwt.decode(refreshToken);
    session.expiresAt = new Date(exp * 1000);
    session.tokenHash = sha256(refreshToken);
    await session.save();
    await enforceSessionCap(user._id, now);
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
    if (typeof user.set === "function") user.set("lastLoginAt", now);
    return {
        accessToken: user.generateAccessToken(),
        refreshToken,
        refreshExpiresAt: session.expiresAt,
        sessionId: String(session._id),
    };
};

/**
 * Exchange a refresh token for a new access token (same session, no rotation).
 * 401 REFRESH_TOKEN_INVALID for unknown/revoked/expired sessions; 403
 * ACCOUNT_DISABLED when the session's (verified) owner is deactivated.
 */
export const refreshSession = async (refreshToken) => {
    const payload = verifyRefreshJwt(refreshToken, { ignoreExpiration: true });
    if (!payload) throw invalidRefresh();
    const session = await AuthSession.findOne({ _id: payload.sid, user: payload._id }).select("+tokenHash");
    if (!session || !hashesEqual(sha256(refreshToken), session.tokenHash)) throw invalidRefresh();

    const now = new Date();
    const user = await User.findById(payload._id).select(USER_AUTH_PROJECTION);
    if (!user) throw invalidRefresh();
    if (user.isActive === false) {
        // The caller proved possession of this session, so telling it why is safe
        // (the UI then shows "account deactivated" instead of "session expired").
        if (!session.revokedAt) {
            await AuthSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: now, revokedReason: "deactivated" } });
        }
        throw accountDisabled();
    }
    const expired = !(session.expiresAt instanceof Date) || session.expiresAt <= now || payload.exp * 1000 <= now.getTime();
    if (session.revokedAt || expired) throw invalidRefresh();

    await AuthSession.updateOne({ _id: session._id }, { $set: { lastUsedAt: now } });
    return { user, accessToken: user.generateAccessToken(), sessionId: String(session._id) };
};

/** Revoke the session behind `refreshToken` (expired tokens accepted). Invalid input is a no-op → false. */
export const revokeSession = async (refreshToken, reason = "logout") => {
    const payload = verifyRefreshJwt(refreshToken, { ignoreExpiration: true });
    if (!payload) return false;
    const session = await AuthSession.findOne({ _id: payload.sid, user: payload._id }).select("+tokenHash");
    if (!session || !hashesEqual(sha256(refreshToken), session.tokenHash) || session.revokedAt) return false;
    const result = await AuthSession.updateOne(
        { _id: session._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    return (result.modifiedCount || 0) > 0;
};

/** Revoke every active session of a user (optionally keeping one). Returns the count. */
export const revokeAllSessions = async (userId, reason, { exceptSessionId } = {}) => {
    const filter = { user: userId, revokedAt: null };
    if (exceptSessionId && OBJECT_ID_RE.test(String(exceptSessionId))) filter._id = { $ne: exceptSessionId };
    const result = await AuthSession.updateMany(filter, { $set: { revokedAt: new Date(), revokedReason: reason } });
    return result.modifiedCount || 0;
};

const presentedRefreshToken = (req) => {
    const fromCookie = req.cookies?.[REFRESH_COOKIE];
    if (typeof fromCookie === "string" && fromCookie) return fromCookie;
    const fromBody = req.body?.refreshToken;
    return typeof fromBody === "string" && fromBody ? fromBody : null;
};

/** The session id of the refresh cookie (or body.refreshToken) when valid, unrevoked and owned by req.user. */
export const currentSessionId = async (req) => {
    const token = presentedRefreshToken(req);
    const payload = verifyRefreshJwt(token);
    if (!payload) return null;
    if (req.user?._id && String(req.user._id) !== payload._id) return null;
    const session = await AuthSession.findOne({ _id: payload.sid, user: payload._id, revokedAt: null }).select("+tokenHash");
    if (!session || !hashesEqual(sha256(token), session.tokenHash)) return null;
    return String(session._id);
};

/** Tell the user's sockets why, then disconnect them shortly after. */
export const kickUserSockets = (userId, reason) => {
    emitToUser(userId, "auth:revoked", { reason });
    const timer = setTimeout(() => {
        try {
            getIO()?.in(rooms.user(userId)).disconnectSockets(true);
        } catch (error) {
            console.warn("[auth] socket disconnect failed:", error?.message || error);
        }
    }, KICK_DELAY_MS);
    timer.unref?.();
};

/**
 * Kill every access token (tokenVersion++) and refresh session of a user,
 * except `exceptSessionId`; optionally kick connected sockets.
 */
export const invalidateUserAccess = async (userId, reason, { exceptSessionId, kick = true } = {}) => {
    const updated = await User.findByIdAndUpdate(
        userId,
        { $inc: { tokenVersion: 1 } },
        { returnDocument: "after", projection: { tokenVersion: 1 } },
    ).lean();
    const revoked = await revokeAllSessions(userId, reason, { exceptSessionId });
    if (kick) kickUserSockets(userId, reason);
    return { tokenVersion: updated?.tokenVersion ?? null, revoked };
};

// ── Cookies ──────────────────────────────────────────────────────────────────

/** httpOnly; SameSite from AUTH_COOKIE_SAMESITE (default strict); Secure in production or with SameSite=None. */
export const authCookieBase = () => ({
    httpOnly: true,
    sameSite: AUTH_COOKIE_SAMESITE,
    secure: NODE_ENV === "production" || AUTH_COOKIE_SAMESITE === "none",
});

export const setAuthCookies = (res, { accessToken, refreshToken, refreshExpiresAt } = {}) => {
    const base = authCookieBase();
    if (accessToken) res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: "/" });
    if (refreshToken) {
        res.cookie(REFRESH_COOKIE, refreshToken, {
            ...base,
            path: REFRESH_COOKIE_PATH,
            ...(refreshExpiresAt ? { expires: new Date(refreshExpiresAt) } : {}),
        });
    }
    return res;
};

export const clearAuthCookies = (res) => {
    const base = authCookieBase();
    res.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
    // Legacy refresh cookie (pre-AuthSession builds set it at "/").
    res.clearCookie(REFRESH_COOKIE, { ...base, path: "/" });
    return res;
};

export { presentedRefreshToken };
