// Authentication for /api/v1/agent-tools/manifest and /execute: ONLY the
// short-lived copilot tool token is accepted (AGENT-TOOLS.md §1), read from
// `Authorization: Bearer <token>` (never from cookies or the query string).
//
// The token is minted by websocket/ai-query-handler.js: HS256 signed with
// AGENT_TOOL_SECRET, claims {sub: userId, role, rid: requestId, sid: sessionId,
// typ: "agent-tool"}, expiresIn 15m. Normal access tokens are signed with a
// different secret and carry no `typ`, so they fail here.
//
// The user is re-loaded from MongoDB on every call: role changes apply
// immediately and deactivated (isActive === false) or deleted users are
// rejected. Every rejection is a 401.
import jwt from "jsonwebtoken";
import { AGENT_TOOL_SECRET } from "../../config/config.js";
import { asyncHandler, fail, isObjectId } from "../../core/http.js";
import { User } from "../../models/user.models.js";
import { TOOL_TOKEN_TYPE } from "./constants.js";
import { buildToolContext } from "./executor.js";

const USER_PROJECTION = "-password -refreshToken -passwordResetToken -passwordResetExpiry";
const BEARER_RE = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const unauthorized = (message, code = "UNAUTHORIZED") => fail(401, message, code);

// `tokenVersion` (session revocation, AUTH-FACULTY.md §3) may not exist on the
// schema; "+path" on a path the schema lacks would break the projection.
const hasTokenVersion = () => Boolean(User.schema.path("tokenVersion"));

const shortClaim = (value) => (typeof value === "string" && value ? value.slice(0, 200) : null);

export const requireToolToken = asyncHandler(async (req, _res, next) => {
    const header = req.get("authorization");
    const match = typeof header === "string" ? BEARER_RE.exec(header.trim()) : null;
    if (!match) throw unauthorized("A copilot tool token is required");
    if (!AGENT_TOOL_SECRET) throw unauthorized("Copilot tools are not configured on this server");

    let claims;
    try {
        claims = jwt.verify(match[1], AGENT_TOOL_SECRET, { algorithms: ["HS256"] });
    } catch (error) {
        if (error?.name === "TokenExpiredError") throw unauthorized("The copilot tool token has expired", "TOKEN_EXPIRED");
        throw unauthorized("Invalid copilot tool token");
    }
    if (!claims || typeof claims !== "object" || claims.typ !== TOOL_TOKEN_TYPE || typeof claims.exp !== "number") {
        throw unauthorized("Invalid copilot tool token");
    }
    if (typeof claims.sub !== "string" || !isObjectId(claims.sub)) throw unauthorized("Invalid copilot tool token");

    const withVersion = hasTokenVersion();
    const user = await User.findById(claims.sub).select(withVersion ? `${USER_PROJECTION} +tokenVersion` : USER_PROJECTION);
    if (!user) throw unauthorized("The account behind this tool token no longer exists");
    if (user.isActive === false) {
        throw unauthorized("This account has been deactivated. Contact your placement office.", "ACCOUNT_DISABLED");
    }
    // Forward-compatible revocation check: only when the token carries `tv`.
    if (withVersion && claims.tv !== undefined && Number(claims.tv) !== Number(user.tokenVersion ?? 0)) {
        throw unauthorized("Your session has ended. Please sign in again.", "SESSION_REVOKED");
    }

    req.user = user;
    req.toolContext = buildToolContext({
        user,
        requestId: shortClaim(claims.rid),
        sessionId: shortClaim(claims.sid),
    });
    return next();
});
