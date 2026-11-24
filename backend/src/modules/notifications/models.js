// Persistence for the notifications module (docs/contracts/NOTIFICATIONS.md).
//
// Other modules never write these models directly: they call notify() from
// ./notify.js. Exception: data-maintenance scripts (demo wipe) may delete by
// `user`, which both collections index.
import mongoose, { Schema } from "mongoose";

export const NOTIFICATION_PRIORITIES = Object.freeze(["low", "normal", "high"]);
export const NOTIFICATION_TYPE_MAX = 100;
export const NOTIFICATION_TITLE_MAX = 140;
export const NOTIFICATION_BODY_MAX = 1000;
export const NOTIFICATION_DEDUPE_KEY_MAX = 200;
// Notifications disappear automatically 90 days after they were created.
export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60;

const notificationSchema = new Schema(
    {
        // Recipient. Indexed through the compound indexes below (user is their prefix).
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        // Dotted namespace, e.g. "attendance.scheduled", "placement.offer.new", "system".
        type: { type: String, required: true, trim: true, maxlength: NOTIFICATION_TYPE_MAX },
        title: { type: String, required: true, trim: true, maxlength: NOTIFICATION_TITLE_MAX },
        body: { type: String, trim: true, maxlength: NOTIFICATION_BODY_MAX, default: "" },
        // UI action opened on click: { panel, params? } (docs/contracts/UI-ACTIONS.md).
        ui: { type: Schema.Types.Mixed, default: undefined },
        // Small structured payload (ids).
        data: { type: Schema.Types.Mixed, default: undefined },
        priority: { type: String, enum: NOTIFICATION_PRIORITIES, default: "normal" },
        // null = unread.
        readAt: { type: Date, default: null },
        // Optional idempotency key, unique per recipient (e.g. "reminder:<sessionId>").
        dedupeKey: { type: String, trim: true, maxlength: NOTIFICATION_DEDUPE_KEY_MAX },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        versionKey: false,
        collection: "notifications",
    },
);

// Inbox listing (newest first) and cursor pagination.
notificationSchema.index({ user: 1, createdAt: -1 });
// Unread counts and unread-only listing.
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
// Retries never duplicate: one notification per (user, dedupeKey) when a key is given.
notificationSchema.index(
    { user: 1, dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } }, name: "user_dedupeKey_unique" },
);
notificationSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: NOTIFICATION_TTL_SECONDS, name: "createdAt_ttl" },
);

const pushSubscriptionSchema = new Schema(
    {
        user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        // Capability URL on the browser vendor's push service.
        endpoint: { type: String, required: true, unique: true, trim: true, maxlength: 2048 },
        keys: {
            p256dh: { type: String, required: true, maxlength: 256 },
            auth: { type: String, required: true, maxlength: 128 },
        },
        expirationTime: { type: Date, default: null },
        userAgent: { type: String, trim: true, maxlength: 300, default: "" },
    },
    {
        timestamps: true,
        versionKey: false,
        collection: "push_subscriptions",
    },
);

// The encryption keys (the `auth` secret in particular) never leave the server.
pushSubscriptionSchema.set("toJSON", {
    transform: (_doc, ret) => {
        delete ret.keys;
        return ret;
    },
});

export const Notification = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
export const PushSubscription = mongoose.models.PushSubscription
    || mongoose.model("PushSubscription", pushSubscriptionSchema);
