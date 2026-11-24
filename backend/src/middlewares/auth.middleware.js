// Request authentication (docs/contracts/AUTH-FACULTY.md §3.4).
//
// verifyJWT: Bearer header first, else the `accessToken` cookie. Rejects
// copilot tool tokens (typ "agent-tool"), deactivated accounts (401
// ACCOUNT_DISABLED — the frontend then tries a refresh, which answers 403) and
// revoked sessions (token `tv` ≠ User.tokenVersion → 401 SESSION_REVOKED).
// core/http.js re-exports it as `requireAuth`, so every module inherits it.
//
// optionalAuth: same checks, but any failure leaves req.user = null.
//
// Errors are built with ApiError directly (not core/http.js `fail`) because
// core/http.js imports this file.
import jwt from "jsonwebtoken";
import { User, USER_AUTH_PROJECTION } from "../models/user.models.js";
import { ApiError } from "../utils/api-error.js";

const AGENT_TOOL_TOKEN_TYPE = "agent-tool";
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const BEARER_RE = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const unauthorized = (message, code = "UNAUTHORIZED") => new ApiError(401, message, [{ code }]);

/** The presented access token: `Authorization: Bearer …` wins over the cookie. */
export const readAccessToken = (req) => {
    const header = typeof req.get === "function" ? req.get("authorization") : req.headers?.authorization;
    if (typeof header === "string" && header.trim()) {
        const match = BEARER_RE.exec(header.trim());
        if (match) return match[1];
    }
    const cookie = req.cookies?.accessToken;
    return typeof cookie === "string" && cookie ? cookie : null;
};

/**
 * Verify an access JWT and load its user.
 * @returns {Promise<import("mongoose").Document>} the user (USER_AUTH_PROJECTION)
 * @throws {ApiError} 401 UNAUTHORIZED | ACCOUNT_DISABLED | SESSION_REVOKED
 */
export const authenticateAccessToken = async (token) => {
    if (!token) throw unauthorized("Unauthorized request");
    let payload;
    try {
        payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { algorithms: ["HS256"] });
    } catch {
        throw unauthorized("Invalid or expired access token");
    }
    if (!payload || typeof payload !== "object" || payload.typ === AGENT_TOOL_TOKEN_TYPE
        || typeof payload._id !== "string" || !OBJECT_ID_RE.test(payload._id)) {
        throw unauthorized("Invalid or expired access token");
    }
    const user = await User.findById(payload._id).select(USER_AUTH_PROJECTION);
    if (!user) throw unauthorized("Invalid or expired access token");
    if (user.isActive === false) {
        throw unauthorized("This account has been deactivated. Contact your placement office.", "ACCOUNT_DISABLED");
    }
    if (Number(payload.tv ?? 0) !== Number(user.tokenVersion ?? 0)) {
        throw unauthorized("Your session has ended. Please sign in again.", "SESSION_REVOKED");
    }
    return user;
};

export const verifyJWT = async (req, _res, next) => {
    try {
        req.user = await authenticateAccessToken(readAccessToken(req));
        return next();
    } catch (error) {
        return next(error);
    }
};

export const optionalAuth = async (req, _res, next) => {
    try {
        const token = readAccessToken(req);
        req.user = token ? await authenticateAccessToken(token) : null;
    } catch {
        req.user = null;
    }
    return next();
};
