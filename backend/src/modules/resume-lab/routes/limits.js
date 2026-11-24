// Shared route rate limits (RESUME-BYOK.md §8.0). One limiter instance per
// budget, so the legacy and catalog upload routes share the same quota.
import { rateLimit } from "../../../core/rate-limit.js";

const byUser = (req) => String(req.user?._id || "anonymous");

/** Uploads / creates: 20 per 10 minutes per user. */
export const uploadLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 20,
    keyFn: byUser,
    message: "Too many uploads. Please wait a few minutes and try again.",
});

/** Signed / owner file downloads: 60 per minute per IP. */
export const fileLimit = rateLimit({
    windowMs: 60_000,
    max: 60,
    message: "Too many file requests. Please wait a moment and try again.",
});
