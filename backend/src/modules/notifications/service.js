// Inbox operations shared by the REST routes, the agent tools and notify().
// Every function takes the acting user's id and only ever touches that user's
// notifications, so ownership is enforced in one place.
import mongoose from "mongoose";
import { FRONTEND_URL } from "../../config/config.js";
import { fail } from "../../core/http.js";
import { emitToUser, getIO, rooms } from "../../core/realtime.js";
import { User } from "../../models/user.models.js";
import { Notification } from "./models.js";

export const MAX_MUTED_TYPES = 50;
const MUTED_TYPE_MAX_LENGTH = 64;
// "attendance.", "placement.offer", "system" (a trailing "*" is accepted and dropped).
const MUTED_TYPE_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/;
const COUNT_CHUNK = 500;
const MAX_TIES_PER_PAGE = 1000;

const toObjectId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

/** Trim and cut to `max` characters with a trailing "…", never splitting a surrogate pair (emoji). */
export const truncateText = (value, max) => {
    if (value === null || value === undefined) return "";
    const text = String(value).trim();
    if (text.length <= max) return text;
    let cut = text.slice(0, max - 1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
};

/** Plain JSON form of a notification (string ids, ISO dates), identical for REST and socket. */
export const serializeNotification = (doc) => {
    if (!doc) return null;
    const plain = typeof doc.toJSON === "function" ? doc.toJSON() : doc;
    return JSON.parse(JSON.stringify(plain));
};

/**
 * Deep link that opens the notification's UI action (docs/contracts/UI-ACTIONS.md §9):
 * `${FRONTEND_URL}/?panel=<id>&params=<encoded JSON>&nid=<notificationId>`.
 * Notifications without `ui` open the notifications inbox.
 */
export const buildNotificationUrl = (notification) => {
    const ui = notification?.ui && typeof notification.ui.panel === "string" ? notification.ui : { panel: "notifications" };
    const params = ui.params && typeof ui.params === "object" && !Array.isArray(ui.params) ? ui.params : {};
    const query = [
        `panel=${encodeURIComponent(ui.panel)}`,
        `params=${encodeURIComponent(JSON.stringify(params))}`,
    ];
    if (notification?._id) query.push(`nid=${encodeURIComponent(String(notification._id))}`);
    return `${FRONTEND_URL}/?${query.join("&")}`;
};

// ── Realtime ────────────────────────────────────────────────────────────────

/** True when the user has at least one socket connected to this process. */
export const isUserOnline = (userId) => {
    if (!userId) return false;
    const adapterRooms = getIO()?.sockets?.adapter?.rooms;
    return Boolean(adapterRooms?.get(rooms.user(userId))?.size);
};

export const countUnread = (userId) => Notification.countDocuments({ user: userId, readAt: null });

/**
 * Emit `notification:count {unread}` to each user. Users without a connected
 * socket are skipped (their client fetches the count when it connects).
 */
export const emitUnreadCounts = async (userIds) => {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))].filter(isUserOnline);
    if (ids.length === 0) return;
    const counts = new Map(ids.map((id) => [id, 0]));
    for (let start = 0; start < ids.length; start += COUNT_CHUNK) {
        const chunk = ids.slice(start, start + COUNT_CHUNK).map(toObjectId);
        const rows = await Notification.aggregate([
            { $match: { user: { $in: chunk }, readAt: null } },
            { $group: { _id: "$user", unread: { $sum: 1 } } },
        ]);
        for (const row of rows) counts.set(String(row._id), row.unread);
    }
    for (const [id, unread] of counts) emitToUser(id, "notification:count", { unread });
};

// Count updates are a courtesy for other open tabs; they never fail the caller.
const syncCounts = async (userId) => {
    try {
        await emitUnreadCounts([userId]);
    } catch (error) {
        console.error("[notifications] failed to emit unread count:", error?.message || error);
    }
};

// ── Inbox ───────────────────────────────────────────────────────────────────

/**
 * Newest-first page of the user's notifications.
 * `nextBefore` is the createdAt (ISO) to pass as `before` for the next page, or
 * null on the last page. Notifications sharing the boundary timestamp are all
 * included in this page, so `before` never skips one.
 * @returns {Promise<{items: object[], unread: number, nextBefore: string|null}>}
 */
export const listNotifications = async (userId, { limit = 30, before = null, unreadOnly = false } = {}) => {
    const base = { user: userId };
    if (unreadOnly) base.readAt = null;
    const query = before ? { ...base, createdAt: { $lt: before } } : base;

    const [docs, unread] = await Promise.all([
        Notification.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
        countUnread(userId),
    ]);

    const items = docs.slice(0, limit);
    let nextBefore = null;
    if (docs.length > limit) {
        const boundary = items[items.length - 1].createdAt;
        if (docs[limit].createdAt.getTime() === boundary.getTime()) {
            const seen = new Set(items.map((item) => String(item._id)));
            const ties = await Notification.find({ ...base, createdAt: boundary })
                .sort({ _id: -1 })
                .limit(MAX_TIES_PER_PAGE)
                .lean();
            for (const tie of ties) {
                if (!seen.has(String(tie._id))) items.push(tie);
            }
        }
        nextBefore = boundary.toISOString();
    }
    return { items: items.map(serializeNotification), unread, nextBefore };
};

/** Mark one notification read (idempotent). Returns it, or null when the user has no such notification. */
export const markRead = async (userId, notificationId) => {
    const updated = await Notification.findOneAndUpdate(
        { _id: notificationId, user: userId, readAt: null },
        { $set: { readAt: new Date() } },
        { returnDocument: "after" },
    ).lean();
    if (updated) {
        await syncCounts(userId);
        return serializeNotification(updated);
    }
    const existing = await Notification.findOne({ _id: notificationId, user: userId }).lean();
    return existing ? serializeNotification(existing) : null;
};

/**
 * Mark several of the user's notifications read.
 * @returns {Promise<{updated: number, found: number}>} `found` = how many of the ids belong to the user
 */
export const markManyRead = async (userId, notificationIds) => {
    const ids = [...new Set(notificationIds.map(String))].map(toObjectId);
    if (ids.length === 0) return { updated: 0, found: 0 };
    const result = await Notification.updateMany(
        { _id: { $in: ids }, user: userId, readAt: null },
        { $set: { readAt: new Date() } },
    );
    const found = await Notification.countDocuments({ _id: { $in: ids }, user: userId });
    if (result.modifiedCount > 0) await syncCounts(userId);
    return { updated: result.modifiedCount, found };
};

/** @returns {Promise<{updated: number}>} */
export const markAllRead = async (userId) => {
    const result = await Notification.updateMany({ user: userId, readAt: null }, { $set: { readAt: new Date() } });
    if (result.modifiedCount > 0) await syncCounts(userId);
    return { updated: result.modifiedCount };
};

/** Delete one of the user's notifications. @returns {Promise<boolean>} false when not found */
export const deleteNotification = async (userId, notificationId) => {
    const removed = await Notification.findOneAndDelete({ _id: notificationId, user: userId }).lean();
    if (!removed) return false;
    if (!removed.readAt) await syncCounts(userId);
    return true;
};

// ── Preferences ─────────────────────────────────────────────────────────────

/** Stored preferences with defaults applied: `{email, push, mutedTypes}`. */
export const normalizePreferences = (prefs) => ({
    email: prefs?.email === true,
    push: prefs?.push !== false,
    mutedTypes: Array.isArray(prefs?.mutedTypes)
        ? [...prefs.mutedTypes].filter((prefix) => typeof prefix === "string" && prefix.length > 0)
        : [],
});

/**
 * True when `type` starts with one of the muted prefixes (same rule as the
 * frontend toast filter, docs/contracts/FRONTEND.md §9.3). Case-insensitive.
 */
export const isTypeMuted = (type, mutedTypes = []) => {
    const normalized = String(type || "").toLowerCase();
    return (mutedTypes || []).some((prefix) => {
        const value = String(prefix || "").toLowerCase().replace(/\*+$/, "");
        return value.length > 0 && normalized.startsWith(value);
    });
};

const parseBoolean = (value, field) => {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw fail(400, `${field} must be true or false`, "VALIDATION", { field });
};

const parseMutedTypes = (value) => {
    const list = typeof value === "string" ? value.split(",") : value;
    if (!Array.isArray(list)) throw fail(400, "mutedTypes must be an array of type prefixes", "VALIDATION", { field: "mutedTypes" });
    const prefixes = [];
    for (const entry of list) {
        if (typeof entry !== "string") {
            throw fail(400, "mutedTypes must only contain strings", "VALIDATION", { field: "mutedTypes" });
        }
        const prefix = entry.trim().toLowerCase().replace(/\*+$/, "");
        if (!prefix) continue;
        if (prefix.length > MUTED_TYPE_MAX_LENGTH || !MUTED_TYPE_PATTERN.test(prefix)) {
            throw fail(400, `"${entry.slice(0, MUTED_TYPE_MAX_LENGTH)}" is not a notification type prefix (e.g. "attendance.")`, "VALIDATION", {
                field: "mutedTypes",
            });
        }
        if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
    if (prefixes.length > MAX_MUTED_TYPES) {
        throw fail(400, `At most ${MAX_MUTED_TYPES} muted types are allowed`, "VALIDATION", { field: "mutedTypes" });
    }
    return prefixes;
};

/** Validate a PUT /preferences body. Fields left out keep their current value. */
export const parsePreferencesInput = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw fail(400, "Send {email, push, mutedTypes}", "VALIDATION");
    }
    const update = {};
    if (body.email !== undefined) update.email = parseBoolean(body.email, "email");
    if (body.push !== undefined) update.push = parseBoolean(body.push, "push");
    if (body.mutedTypes !== undefined) update.mutedTypes = parseMutedTypes(body.mutedTypes);
    if (Object.keys(update).length === 0) {
        throw fail(400, "Provide at least one of email, push or mutedTypes", "VALIDATION");
    }
    return update;
};

export const getPreferences = async (userId) => {
    const user = await User.findById(userId).select("notificationPreferences").lean();
    if (!user) throw fail(404, "User not found", "NOT_FOUND");
    return normalizePreferences(user.notificationPreferences);
};

export const updatePreferences = async (userId, update) => {
    const current = await getPreferences(userId);
    const next = { ...current, ...update };
    const user = await User.findByIdAndUpdate(
        userId,
        { $set: { notificationPreferences: next } },
        { returnDocument: "after", runValidators: true, projection: { notificationPreferences: 1 } },
    ).lean();
    if (!user) throw fail(404, "User not found", "NOT_FOUND");
    return normalizePreferences(user.notificationPreferences);
};
