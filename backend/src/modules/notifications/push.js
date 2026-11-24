// Web push (VAPID) for the notifications module.
//
// Push is enabled only when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY hold a
// matching P-256 key pair (generate one with `npx web-push generate-vapid-keys`).
// VAPID_SUBJECT is the contact URI push services may use (`mailto:` or
// `https:`); it defaults to FRONTEND_URL when that is https, else to a mailto:
// address derived from SMTP_FROM. Without keys every push is a no-op and
// GET /api/v1/notifications/push/public-key reports `enabled: false`.
//
// The environment is read lazily (on every call, validated once per value), so
// keys can be rotated by restarting with new values and tests can toggle them.
import crypto from "node:crypto";
import { getVapidHeaders, sendNotification } from "web-push";
import { FRONTEND_URL, SMTP_FROM } from "../../config/config.js";
import { fail } from "../../core/http.js";

// Browsers only hand out endpoints on these push services. Restricting the hosts
// keeps POST /push/subscribe from turning the server into an HTTP client for
// arbitrary URLs (SSRF). Matched as the host itself or any subdomain of it.
export const PUSH_SERVICE_HOSTS = Object.freeze([
    "googleapis.com", // Chrome, Chromium Edge, Opera, Samsung Internet (fcm.googleapis.com)
    "google.com", // Chrome endpoints served from Google edge hosts
    "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
    "notify.windows.com", // legacy Edge / Windows (wns2-*.notify.windows.com)
    "push.apple.com", // Safari 16+, iOS/iPadOS 16.4+ home-screen apps (web.push.apple.com)
]);

/** Devices kept per user; subscribing another one drops the least recently refreshed. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
let vapidCache = { signature: null, config: null };
let customSender = null;

const resolveVapidSubject = () => {
    const configured = (process.env.VAPID_SUBJECT || "").trim();
    if (configured) return configured;
    if (/^https:\/\//i.test(FRONTEND_URL)) return FRONTEND_URL;
    const address = String(SMTP_FROM || "").match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/)?.[0];
    return `mailto:${address || "webpush@example.com"}`;
};

const assertMatchingKeyPair = (publicKey, privateKey) => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (!ecdh.getPublicKey().equals(Buffer.from(publicKey, "base64url"))) {
        throw new Error("VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY");
    }
};

/**
 * The validated VAPID configuration, or null when push is not configured.
 * Never logs key material; an invalid configuration is reported once.
 * @returns {{subject: string, publicKey: string, privateKey: string} | null}
 */
export const getVapidConfig = () => {
    const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
    const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
    if (!publicKey || !privateKey) return null;

    const subject = resolveVapidSubject();
    const signature = `${subject}\n${publicKey}\n${privateKey}`;
    if (vapidCache.signature === signature) return vapidCache.config;

    let config = null;
    try {
        // Validates the subject and both keys exactly as sending would.
        getVapidHeaders("https://fcm.googleapis.com", subject, publicKey, privateKey, "aes128gcm");
        assertMatchingKeyPair(publicKey, privateKey);
        config = Object.freeze({ subject, publicKey, privateKey });
    } catch (error) {
        console.error(`[notifications] Web push disabled: invalid VAPID configuration (${error?.message || error}).`);
    }
    vapidCache = { signature, config };
    return config;
};

export const isPushConfigured = () => Boolean(getVapidConfig());

export const getVapidPublicKey = () => getVapidConfig()?.publicKey || null;

/**
 * Replace the function that delivers a push message (tests, custom gateways).
 * It receives `(subscription, payloadString, options)` like web-push's
 * sendNotification and must reject with `{statusCode}` on HTTP failures.
 * Pass null to restore web-push.
 */
export const setPushSender = (fn) => {
    customSender = typeof fn === "function" ? fn : null;
};

export const isAllowedPushHost = (hostname) => {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
};

/** Host of a push endpoint, for logs (endpoints are capability URLs; never log them whole). */
export const endpointHost = (endpoint) => {
    try {
        return new URL(endpoint).hostname;
    } catch {
        return "invalid-endpoint";
    }
};

const normalizeKey = (value) => (typeof value === "string"
    ? value.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    : "");

const invalid = (message, field) => fail(400, message, "VALIDATION", { field });

/**
 * Validate the JSON form of a browser PushSubscription (`subscription.toJSON()`).
 * @returns {{endpoint: string, keys: {p256dh: string, auth: string}, expirationTime: Date|null}}
 */
export const normalizeSubscription = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw invalid("subscription must be the object returned by PushSubscription.toJSON()", "subscription");
    }
    const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
    if (!endpoint || endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) {
        throw invalid("subscription.endpoint is required", "subscription.endpoint");
    }
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        throw invalid("subscription.endpoint must be a URL", "subscription.endpoint");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !isAllowedPushHost(url.hostname)) {
        throw fail(400, "This browser's push service is not supported", "PUSH_ENDPOINT_NOT_ALLOWED", {
            field: "subscription.endpoint",
        });
    }

    const p256dh = normalizeKey(input.keys?.p256dh);
    const auth = normalizeKey(input.keys?.auth);
    if (!BASE64URL.test(p256dh)) throw invalid("subscription.keys.p256dh is required", "subscription.keys.p256dh");
    if (!BASE64URL.test(auth)) throw invalid("subscription.keys.auth is required", "subscription.keys.auth");
    const p256dhBytes = Buffer.from(p256dh, "base64url");
    if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) {
        throw invalid("subscription.keys.p256dh must be an uncompressed P-256 public key", "subscription.keys.p256dh");
    }
    const authBytes = Buffer.from(auth, "base64url");
    if (authBytes.length < 16 || authBytes.length > 64) {
        throw invalid("subscription.keys.auth must be a 16-byte secret", "subscription.keys.auth");
    }

    let expirationTime = null;
    if (input.expirationTime !== undefined && input.expirationTime !== null) {
        const millis = Number(input.expirationTime);
        if (!Number.isFinite(millis) || millis <= 0) {
            throw invalid("subscription.expirationTime must be a timestamp or null", "subscription.expirationTime");
        }
        expirationTime = new Date(millis);
    }

    return { endpoint, keys: { p256dh, auth }, expirationTime };
};

/**
 * Send one push message. Resolves `{skipped: true}` when push is not configured;
 * rejects like web-push (WebPushError with `statusCode`) when the service refuses.
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
 * @param {object|string} payload JSON payload (see docs/contracts/FRONTEND.md §9.4)
 * @param {{urgency?: "very-low"|"low"|"normal"|"high", ttlSeconds?: number}} [options]
 */
export const sendWebPush = async (subscription, payload, { urgency = "normal", ttlSeconds = 24 * 60 * 60 } = {}) => {
    const vapid = getVapidConfig();
    if (!vapid) return { skipped: true };
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const target = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys?.p256dh, auth: subscription.keys?.auth },
    };
    const options = {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: ttlSeconds,
        urgency,
        timeout: 10_000,
    };
    return (customSender || sendNotification)(target, body, options);
};
