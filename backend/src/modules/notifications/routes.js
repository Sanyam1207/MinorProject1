// REST API mounted at /api/v1/notifications (docs/contracts/NOTIFICATIONS.md).
// Every route requires a normal access token and only touches the caller's own
// notifications, push subscriptions and preferences.
import { Router } from "express";
import { assertObjectId, asyncHandler, fail, intParam, requireAuth, send } from "../../core/http.js";
import { rateLimit } from "../../core/rate-limit.js";
import { PushSubscription } from "./models.js";
import {
    getVapidPublicKey,
    isPushConfigured,
    MAX_PUSH_SUBSCRIPTIONS_PER_USER,
    normalizeSubscription,
    PUSH_ENDPOINT_MAX_LENGTH,
} from "./push.js";
import {
    countUnread,
    deleteNotification,
    getPreferences,
    listNotifications,
    markAllRead,
    markRead,
    parsePreferencesInput,
    updatePreferences,
} from "./service.js";

const router = Router();
router.use(requireAuth);

const firstValue = (value) => (Array.isArray(value) ? value[0] : value);

const parseFlag = (value) => ["true", "1", "yes"].includes(String(firstValue(value) ?? "").trim().toLowerCase());

const parseBefore = (value) => {
    const raw = firstValue(value);
    if (raw === undefined || raw === null || String(raw).trim() === "") return null;
    const text = String(raw).trim();
    const date = new Date(/^\d+$/.test(text) ? Number(text) : text);
    if (Number.isNaN(date.getTime())) {
        throw fail(400, "before must be an ISO date (use nextBefore from the previous page)", "VALIDATION", { field: "before" });
    }
    return date;
};

const subscribeLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => String(req.user?._id || ""),
    message: "Too many push subscription attempts. Please wait a moment and try again.",
});

// ── Inbox ───────────────────────────────────────────────────────────────────

router.get("/", asyncHandler(async (req, res) => {
    const limit = intParam(firstValue(req.query.limit), { min: 1, max: 100, fallback: 30 });
    const before = parseBefore(req.query.before);
    const unreadOnly = parseFlag(req.query.unreadOnly);
    send(res, await listNotifications(req.user._id, { limit, before, unreadOnly }), "Notifications fetched");
}));

router.get("/unread-count", asyncHandler(async (req, res) => {
    send(res, { unread: await countUnread(req.user._id) }, "Unread count fetched");
}));

router.post("/read-all", asyncHandler(async (req, res) => {
    send(res, await markAllRead(req.user._id), "All notifications marked as read");
}));

// ── Web push ────────────────────────────────────────────────────────────────

router.get("/push/public-key", asyncHandler(async (_req, res) => {
    const publicKey = getVapidPublicKey();
    send(res, { enabled: Boolean(publicKey), publicKey }, publicKey ? "Push is enabled" : "Push is not configured on the server");
}));

router.post("/push/subscribe", subscribeLimiter, asyncHandler(async (req, res) => {
    if (!isPushConfigured()) {
        throw fail(503, "Push notifications are not configured on the server", "PUSH_DISABLED");
    }
    const subscription = normalizeSubscription(req.body?.subscription);
    const userId = req.user._id;
    const update = {
        $set: {
            user: userId,
            keys: subscription.keys,
            expirationTime: subscription.expirationTime,
            userAgent: String(req.get("user-agent") || "").slice(0, 300),
        },
    };
    // The endpoint identifies the browser profile: when another account used it
    // before (shared device), it now belongs to whoever subscribed last.
    try {
        await PushSubscription.updateOne({ endpoint: subscription.endpoint }, update, { upsert: true, runValidators: true });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        // Lost an upsert race against a parallel request; the row exists now.
        await PushSubscription.updateOne({ endpoint: subscription.endpoint }, update, { runValidators: true });
    }

    const surplus = await PushSubscription.find({ user: userId })
        .sort({ updatedAt: -1, _id: -1 })
        .skip(MAX_PUSH_SUBSCRIPTIONS_PER_USER)
        .select("_id")
        .lean();
    if (surplus.length > 0) {
        await PushSubscription.deleteMany({ _id: { $in: surplus.map((row) => row._id) } });
    }
    send(res, { subscribed: true }, "Push notifications enabled on this device");
}));

router.post("/push/unsubscribe", asyncHandler(async (req, res) => {
    const raw = req.body?.endpoint ?? req.body?.subscription?.endpoint;
    const endpoint = typeof raw === "string" ? raw.trim() : "";
    if (!endpoint || endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) {
        throw fail(400, "endpoint is required", "VALIDATION", { field: "endpoint" });
    }
    const { deletedCount } = await PushSubscription.deleteOne({ endpoint, user: req.user._id });
    send(res, { unsubscribed: true, removed: deletedCount > 0 }, "Push notifications disabled on this device");
}));

// ── Preferences ─────────────────────────────────────────────────────────────

router.get("/preferences", asyncHandler(async (req, res) => {
    send(res, await getPreferences(req.user._id), "Notification preferences fetched");
}));

router.put("/preferences", asyncHandler(async (req, res) => {
    const update = parsePreferencesInput(req.body);
    send(res, await updatePreferences(req.user._id, update), "Notification preferences saved");
}));

// ── Single notification (after the static paths above) ──────────────────────

router.post("/:id/read", asyncHandler(async (req, res) => {
    const id = assertObjectId(req.params.id, "id");
    const notification = await markRead(req.user._id, id);
    if (!notification) throw fail(404, "Notification not found", "NOT_FOUND");
    send(res, { notification }, "Notification marked as read");
}));

router.delete("/:id", asyncHandler(async (req, res) => {
    const id = assertObjectId(req.params.id, "id");
    const deleted = await deleteNotification(req.user._id, id);
    if (!deleted) throw fail(404, "Notification not found", "NOT_FOUND");
    send(res, { deleted: true }, "Notification deleted");
}));

export default router;
