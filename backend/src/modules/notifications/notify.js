// notify(): the ONLY way modules create notifications (docs/contracts/NOTIFICATIONS.md).
//
//   import { notify } from "../notifications/notify.js";
//   await notify(userIds, { type, title, body, ui, data, priority, dedupeKey, email, push });
//   // → { created: n }
//
// Pipeline per call:
//   1. insertMany (ordered:false). A (user, dedupeKey) pair that already exists
//      is skipped, so retries and re-runs never duplicate.
//   2. Realtime: `notification:new {notification}` and `notification:count
//      {unread}` to room user:<id> of every recipient with a connected socket.
//   3. Web push (background, best effort) when VAPID is configured, `push` is
//      not false and the user is subscribed. Preferences: `push:false` or a muted
//      type disables it. Priority: `high` always pushes; `normal` pushes only to
//      users without a connected socket (the in-app toast covers the others);
//      `low` never pushes. Subscriptions answering 404/410 are deleted.
//   4. Email (background, best effort) when `email:true`, SMTP is configured,
//      the user enabled `notificationPreferences.email` and the type is not muted.
// Steps 1–2 are awaited; failures in 3–4 are logged and never thrown.
// Muting never hides the in-app notification itself: the inbox stays complete
// and the frontend skips the toast (docs/contracts/FRONTEND.md §9.3).
import { APP_NAME } from "../../config/config.js";
import { isMailerConfigured, renderEmail, sendMail } from "../../core/mailer.js";
import { emitToUser } from "../../core/realtime.js";
import { User } from "../../models/user.models.js";
import {
    Notification,
    NOTIFICATION_BODY_MAX,
    NOTIFICATION_DEDUPE_KEY_MAX,
    NOTIFICATION_PRIORITIES,
    NOTIFICATION_TITLE_MAX,
    NOTIFICATION_TYPE_MAX,
    PushSubscription,
} from "./models.js";
import { endpointHost, isPushConfigured, sendWebPush, setPushSender } from "./push.js";
import {
    buildNotificationUrl,
    emitUnreadCounts,
    isTypeMuted,
    isUserOnline,
    normalizePreferences,
    serializeNotification,
    truncateText,
} from "./service.js";

export { setPushSender };

const INSERT_BATCH = 1000;
const UI_PARAMS_MAX_BYTES = 2048;
const DATA_MAX_BYTES = 16 * 1024;
const PUSH_BODY_MAX = 300;
const PUSH_PAYLOAD_MAX_BYTES = 3000;
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_CONCURRENCY = 8;
const EMAIL_CONCURRENCY = 4;
const PANEL_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const HEX_ID = /^[a-f\d]{24}$/i;

let customMailSender = null;
const pendingDeliveries = new Set();

const warn = (message) => {
    if (process.env.NODE_ENV !== "test") console.warn(`[notifications] ${message}`);
};

/**
 * Replace the function that sends notification emails (tests, custom gateways).
 * It receives `{to, subject, text, html}` like core/mailer.js sendMail. While
 * set, email counts as configured. Pass null to restore SMTP.
 */
export const setMailSender = (fn) => {
    customMailSender = typeof fn === "function" ? fn : null;
};

/** Resolve once every background push/email delivery started so far has finished. */
export const flushDeliveries = async () => {
    while (pendingDeliveries.size > 0) {
        await Promise.allSettled([...pendingDeliveries]);
    }
};

// ── Input normalisation ─────────────────────────────────────────────────────

const toIdString = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
        const trimmed = value.trim();
        return HEX_ID.test(trimmed) ? trimmed.toLowerCase() : null;
    }
    if (typeof value === "object") {
        if (typeof value.toHexString === "function") return value.toHexString();
        if (value._id !== undefined && value._id !== value) return toIdString(value._id);
    }
    return null;
};

/** ObjectId | string | {_id} | an array/Set of those → unique hex id strings (invalid entries dropped). */
export const normalizeRecipients = (userIds) => {
    let list;
    if (userIds instanceof Set) list = [...userIds];
    else if (Array.isArray(userIds)) list = userIds.flat(Infinity);
    else list = [userIds];
    const unique = new Set();
    for (const value of list) {
        const id = toIdString(value);
        if (id) unique.add(id);
    }
    return [...unique];
};

const jsonClone = (value) => {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? undefined : { json, value: JSON.parse(json) };
    } catch {
        return undefined;
    }
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `{panel, params?}` only (UI-ACTIONS.md §1: `id`/`data` are not stored); invalid → undefined. */
const sanitizeUi = (ui) => {
    if (Array.isArray(ui)) {
        for (const candidate of ui) {
            const action = sanitizeUi(candidate);
            if (action) return action;
        }
        return undefined;
    }
    if (!isPlainObject(ui) || typeof ui.panel !== "string" || !PANEL_ID.test(ui.panel.trim())) {
        if (ui !== undefined && ui !== null) warn("dropped an invalid `ui` action (needs {panel, params?})");
        return undefined;
    }
    const action = { panel: ui.panel.trim() };
    if (isPlainObject(ui.params)) {
        const clone = jsonClone(ui.params);
        if (clone && Buffer.byteLength(clone.json) <= UI_PARAMS_MAX_BYTES) {
            if (Object.keys(clone.value).length > 0) action.params = clone.value;
        } else {
            warn(`dropped oversized or non-JSON params for panel "${action.panel}"`);
        }
    }
    return action;
};

const sanitizeData = (data) => {
    if (data === undefined || data === null) return undefined;
    const clone = jsonClone(data);
    if (!clone || Buffer.byteLength(clone.json) > DATA_MAX_BYTES) {
        warn("dropped `data` that is not JSON or larger than 16 KB");
        return undefined;
    }
    return clone.value;
};

const normalizePayload = (payload) => {
    if (!isPlainObject(payload)) throw new TypeError("notify(userIds, payload): payload must be an object");
    const type = typeof payload.type === "string" ? payload.type.trim() : "";
    if (!type) throw new TypeError("notify(): `type` is required, e.g. \"attendance.scheduled\"");
    if (type.length > NOTIFICATION_TYPE_MAX) throw new TypeError(`notify(): \`type\` is longer than ${NOTIFICATION_TYPE_MAX} characters`);
    const title = truncateText(payload.title, NOTIFICATION_TITLE_MAX);
    if (!title) throw new TypeError("notify(): `title` is required");

    const rawKey = typeof payload.dedupeKey === "number" ? String(payload.dedupeKey) : payload.dedupeKey;
    const dedupeKey = typeof rawKey === "string" && rawKey.trim()
        ? rawKey.trim().slice(0, NOTIFICATION_DEDUPE_KEY_MAX)
        : undefined;

    return {
        type,
        title,
        body: truncateText(payload.body, NOTIFICATION_BODY_MAX),
        ui: sanitizeUi(payload.ui),
        data: sanitizeData(payload.data),
        priority: NOTIFICATION_PRIORITIES.includes(payload.priority) ? payload.priority : "normal",
        dedupeKey,
        email: payload.email === true,
        push: payload.push !== false,
    };
};

// ── Steps ───────────────────────────────────────────────────────────────────

const isDuplicateKeyError = (error) => {
    const writeErrors = error?.writeErrors ?? error?.result?.result?.writeErrors;
    if (Array.isArray(writeErrors) && writeErrors.length > 0) {
        return writeErrors.every((writeError) => (writeError?.code ?? writeError?.err?.code) === 11000);
    }
    return error?.code === 11000;
};

const insertNotifications = async (recipients, content) => {
    const fields = {
        type: content.type,
        title: content.title,
        body: content.body,
        priority: content.priority,
    };
    if (content.ui) fields.ui = content.ui;
    if (content.data !== undefined) fields.data = content.data;
    if (content.dedupeKey) fields.dedupeKey = content.dedupeKey;

    const created = [];
    for (let start = 0; start < recipients.length; start += INSERT_BATCH) {
        let batch = recipients.slice(start, start + INSERT_BATCH);
        if (content.dedupeKey) {
            // Skip known duplicates up front; the unique index still guards races.
            const existing = await Notification.distinct("user", { user: { $in: batch }, dedupeKey: content.dedupeKey });
            if (existing.length > 0) {
                const seen = new Set(existing.map(String));
                batch = batch.filter((id) => !seen.has(id));
            }
        }
        if (batch.length === 0) continue;
        try {
            created.push(...await Notification.insertMany(batch.map((user) => ({ user, ...fields })), { ordered: false }));
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            created.push(...(error.insertedDocs || []));
        }
    }
    return created.map(serializeNotification);
};

const emitCreated = async (created) => {
    try {
        const online = created.filter((notification) => isUserOnline(notification.user));
        if (online.length === 0) return;
        for (const notification of online) emitToUser(notification.user, "notification:new", { notification });
        await emitUnreadCounts(online.map((notification) => notification.user));
    } catch (error) {
        // The notifications are saved; clients resync their count on reconnect.
        console.error("[notifications] realtime emit failed:", error?.message || error);
    }
};

const mapWithConcurrency = async (items, limit, fn) => {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next];
            next += 1;
            try {
                await fn(item);
            } catch (error) {
                console.error("[notifications] delivery step failed:", error?.message || error);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

const wantsChannel = (user, channel, type) => {
    if (!user || user.isActive === false) return false;
    const prefs = normalizePreferences(user.notificationPreferences);
    if (!prefs[channel]) return false;
    return !isTypeMuted(type, prefs.mutedTypes);
};

const buildPushPayload = (notification) => {
    const payload = {
        title: notification.title,
        body: truncateText(notification.body, PUSH_BODY_MAX),
        url: buildNotificationUrl(notification),
        tag: notification.dedupeKey || notification._id,
        notificationId: notification._id,
        priority: notification.priority,
    };
    let json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > PUSH_PAYLOAD_MAX_BYTES) {
        // Push services cap payloads at ~4 KB: fall back to opening the inbox.
        payload.body = "";
        payload.url = buildNotificationUrl({ _id: notification._id });
        json = JSON.stringify(payload);
    }
    return json;
};

const deliverPush = async (created, content) => {
    const candidates = content.priority === "high"
        ? created
        : created.filter((notification) => !isUserOnline(notification.user));
    if (candidates.length === 0) return;
    const byUser = new Map(candidates.map((notification) => [String(notification.user), notification]));

    const subscriptions = await PushSubscription.find({ user: { $in: [...byUser.keys()] } }).lean();
    if (subscriptions.length === 0) return;
    const subscriberIds = [...new Set(subscriptions.map((subscription) => String(subscription.user)))];
    const users = await User.find({ _id: { $in: subscriberIds } }).select("isActive notificationPreferences").lean();
    const allowed = new Set(users.filter((user) => wantsChannel(user, "push", content.type)).map((user) => String(user._id)));

    const now = Date.now();
    const gone = [];
    await mapWithConcurrency(subscriptions, PUSH_CONCURRENCY, async (subscription) => {
        const userId = String(subscription.user);
        if (!allowed.has(userId)) return;
        if (subscription.expirationTime && new Date(subscription.expirationTime).getTime() <= now) {
            gone.push(subscription._id);
            return;
        }
        try {
            await sendWebPush(subscription, buildPushPayload(byUser.get(userId)), {
                urgency: content.priority === "high" ? "high" : "normal",
                ttlSeconds: PUSH_TTL_SECONDS,
            });
        } catch (error) {
            if (error?.statusCode === 404 || error?.statusCode === 410) {
                gone.push(subscription._id);
            } else {
                warn(`web push to ${endpointHost(subscription.endpoint)} failed (${error?.statusCode || error?.message || error})`);
            }
        }
    });
    if (gone.length > 0) await PushSubscription.deleteMany({ _id: { $in: gone } });
};

const deliverEmail = async (created, content) => {
    const byUser = new Map(created.map((notification) => [String(notification.user), notification]));
    const users = await User.find({
        _id: { $in: [...byUser.keys()] },
        "notificationPreferences.email": true,
        isActive: { $ne: false },
    }).select("email isActive notificationPreferences").lean();
    const send = customMailSender || sendMail;

    await mapWithConcurrency(users, EMAIL_CONCURRENCY, async (user) => {
        if (!user.email || !wantsChannel(user, "email", content.type)) return;
        const notification = byUser.get(String(user._id));
        const url = buildNotificationUrl(notification);
        const actionLabel = `Open in ${APP_NAME}`;
        try {
            await send({
                to: user.email,
                subject: notification.title,
                text: `${notification.body ? `${notification.body}\n\n` : ""}${actionLabel}: ${url}`,
                html: renderEmail({ title: notification.title, body: notification.body, actionUrl: url, actionLabel }),
            });
        } catch (error) {
            warn(`notification email to user ${user._id} failed (${error?.message || error})`);
        }
    });
};

const scheduleExternalDelivery = (created, content) => {
    const wantPush = content.push && content.priority !== "low" && isPushConfigured();
    const wantEmail = content.email && (Boolean(customMailSender) || isMailerConfigured());
    if (!wantPush && !wantEmail) return;

    const task = (async () => {
        if (wantPush) {
            try {
                await deliverPush(created, content);
            } catch (error) {
                console.error("[notifications] web push delivery failed:", error?.message || error);
            }
        }
        if (wantEmail) {
            try {
                await deliverEmail(created, content);
            } catch (error) {
                console.error("[notifications] email delivery failed:", error?.message || error);
            }
        }
    })();
    pendingDeliveries.add(task);
    task.finally(() => pendingDeliveries.delete(task));
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create one in-app notification per recipient and fan it out (realtime, web
 * push, email). Invalid or duplicate recipient ids are ignored. Titles longer
 * than 140 characters and bodies longer than 1000 are truncated.
 *
 * @param {import("mongoose").Types.ObjectId|string|{_id: any}|Array<any>|Set<any>} userIds
 * @param {{
 *   type: string, title: string, body?: string,
 *   ui?: {panel: string, params?: object}, data?: object,
 *   priority?: "low"|"normal"|"high", dedupeKey?: string,
 *   email?: boolean, push?: boolean,
 * }} payload `priority` defaults to "normal", `email` to false, `push` to true.
 * @returns {Promise<{created: number}>} number of notifications actually inserted
 *   (recipients that already had `dedupeKey` are not counted)
 * @throws {TypeError} when `type` or `title` is missing; database errors propagate.
 */
export const notify = async (userIds, payload) => {
    const content = normalizePayload(payload);
    const recipients = normalizeRecipients(userIds);
    if (recipients.length === 0) return { created: 0 };

    const created = await insertNotifications(recipients, content);
    if (created.length === 0) return { created: 0 };

    await emitCreated(created);
    scheduleExternalDelivery(created, content);
    return { created: created.length };
};

/**
 * notify() every user matching a User query, streamed in batches (announcements,
 * role-wide alerts). Users with `isActive: false` are excluded unless the filter
 * sets `isActive` itself. The filter is a MongoDB query: build it from trusted
 * values only, never from raw request input.
 * @returns {Promise<{created: number, recipients: number}>}
 */
export const notifyUsersWhere = async (filter, payload, { batchSize = 500 } = {}) => {
    if (!isPlainObject(filter)) throw new TypeError("notifyUsersWhere(filter, payload): filter must be a User query object");
    normalizePayload(payload);
    const size = Math.min(1000, Math.max(1, Number.parseInt(batchSize, 10) || 500));
    let batch = [];
    let created = 0;
    let recipients = 0;
    const flush = async () => {
        if (batch.length === 0) return;
        const ids = batch;
        batch = [];
        recipients += ids.length;
        created += (await notify(ids, payload)).created;
        await new Promise((resolve) => setImmediate(resolve));
    };

    const cursor = User.find({ isActive: { $ne: false }, ...filter }).select("_id").lean().cursor({ batchSize: size });
    for await (const user of cursor) {
        batch.push(user._id);
        if (batch.length >= size) await flush();
    }
    await flush();
    return { created, recipients };
};

/**
 * notify() every active user with the given role(s), optionally narrowed by an
 * extra User filter, e.g. notifyRole("student", payload, { college, branch: "CSE", passingYear: "2026" }).
 * @param {string|string[]} role
 * @returns {Promise<{created: number, recipients: number}>}
 */
export const notifyRole = async (role, payload, filter = {}) => {
    const roles = (Array.isArray(role) ? role : [role]).map((value) => String(value ?? "").trim()).filter(Boolean);
    if (roles.length === 0) throw new TypeError("notifyRole(role, payload, filter): role is required");
    if (!isPlainObject(filter)) throw new TypeError("notifyRole(role, payload, filter): filter must be an object");
    return notifyUsersWhere({ ...filter, role: roles.length === 1 ? roles[0] : { $in: roles } }, payload);
};

export default notify;
