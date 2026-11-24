// Shared HTTP helpers for feature modules. They wrap the existing SIH
// envelope (utils/api-response.js, utils/api-error.js) so every endpoint
// answers with the same shape:
//   success: { statusCode, data, message, success: true }
//   failure: { success: false, message, errors: [{ code, ... }], data: null }
import mongoose from "mongoose";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";

export { default as asyncHandler } from "../utils/asynchandler.js";
export { verifyJWT as requireAuth } from "../middlewares/auth.middleware.js";

/** Build an ApiError whose first error carries a machine-readable code. */
export const fail = (statusCode, message, code = "ERROR", extra = {}) =>
    new ApiError(statusCode, message, [{ code, ...extra }]);

/** Send the standard success envelope. */
export const send = (res, data, message = "success", statusCode = 200) =>
    res.status(statusCode).json(new Apiresponse(statusCode, data, message));

/**
 * Role guard. `admin` is a superuser and always passes.
 * Usage: router.post("/", requireAuth, requireRole("teacher"), handler)
 */
export const requireRole = (...roles) => (req, _res, next) => {
    if (!req.user) return next(fail(401, "Unauthorized request", "UNAUTHORIZED"));
    if (req.user.role === "admin" || roles.includes(req.user.role)) return next();
    return next(fail(403, `This action requires one of these roles: ${roles.join(", ")}`, "FORBIDDEN"));
};

export const hasRole = (user, ...roles) => Boolean(user) && (user.role === "admin" || roles.includes(user.role));

export const isObjectId = (value) =>
    typeof value === "string" ? mongoose.isValidObjectId(value) && /^[a-f\d]{24}$/i.test(value) : value instanceof mongoose.Types.ObjectId;

/** Throw a 400 VALIDATION error unless `value` is a valid ObjectId string. */
export const assertObjectId = (value, field = "id") => {
    if (!isObjectId(value)) throw fail(400, `${field} must be a valid id`, "VALIDATION", { field });
    return String(value);
};

/** Clamp a query-string integer. */
export const intParam = (value, { min = 1, max = 100, fallback = 20 } = {}) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

/** Escape user text for use inside a RegExp. */
export const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
