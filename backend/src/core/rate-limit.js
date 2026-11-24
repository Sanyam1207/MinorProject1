// Small in-memory sliding-window rate limiter (single-process deployments).
//
//   router.post("/login", rateLimit({ windowMs: 15 * 60_000, max: 20 }), handler)
//   const limiter = createLimiter({ windowMs: 60_000, max: 10 });
//   if (!limiter.hit(`scan:${userId}`)) throw fail(429, "...", "TOO_MANY_ATTEMPTS");
import { fail } from "./http.js";

export const createLimiter = ({ windowMs = 60_000, max = 10 } = {}) => {
    const hits = new Map();

    const sweep = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, timestamps] of hits) {
            const fresh = timestamps.filter((time) => time > cutoff);
            if (fresh.length) hits.set(key, fresh);
            else hits.delete(key);
        }
    }, Math.max(windowMs, 30_000));
    sweep.unref?.();

    return {
        /** Record one attempt; returns false when the key is over the limit. */
        hit(key) {
            const now = Date.now();
            const cutoff = now - windowMs;
            const timestamps = (hits.get(key) || []).filter((time) => time > cutoff);
            if (timestamps.length >= max) {
                hits.set(key, timestamps);
                return false;
            }
            timestamps.push(now);
            hits.set(key, timestamps);
            return true;
        },
        reset(key) {
            hits.delete(key);
        },
    };
};

/** Express middleware. Keyed by client IP (plus `keyFn(req)` when provided). */
export const rateLimit = ({
    windowMs = 60_000,
    max = 10,
    keyFn = null,
    message = "Too many attempts. Please wait a moment and try again.",
    code = "TOO_MANY_ATTEMPTS",
} = {}) => {
    const limiter = createLimiter({ windowMs, max });
    return (req, _res, next) => {
        if (process.env.NODE_ENV === "test" && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== "true") return next();
        const key = `${req.ip}|${keyFn ? keyFn(req) : ""}`;
        if (!limiter.hit(key)) return next(fail(429, message, code));
        return next();
    };
};
