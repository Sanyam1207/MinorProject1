// Copilot tools for the notifications module (docs/contracts/AGENT-TOOLS.md §2, §4).
// Handlers run as the logged-in user (`ctx.user`) and only see that user's inbox.
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../../config/config.js";
import { fail, isObjectId } from "../../core/http.js";
import { countUnread, listNotifications, markAllRead, markManyRead, truncateText } from "./service.js";

const ALL_ROLES = Object.freeze(["student", "teacher", "tpo", "admin", "company", "alumni"]);
const LIST_DEFAULT = 10;
const LIST_MAX = 50;
const MARK_MAX_IDS = 100;

const requireUserId = (ctx) => {
    const userId = ctx?.user?._id;
    if (!userId) throw fail(401, "Sign in to use notifications", "UNAUTHORIZED");
    return userId;
};

const toBoolean = (value) => value === true || ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());

const toLimit = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return LIST_DEFAULT;
    return Math.min(LIST_MAX, Math.max(1, parsed));
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const snippet = (text, max) => truncateText(String(text || "").replace(/\s+/g, " "), max);

const formatWhen = (iso, zone) => {
    const date = DateTime.fromISO(String(iso));
    const zoned = date.setZone(zone || APP_TIMEZONE);
    return (zoned.isValid ? zoned : date.setZone(APP_TIMEZONE)).toFormat("d LLL, HH:mm");
};

/** @returns {{requested: number, ids: string[]}} distinct non-empty entries and the valid ids among them */
const parseIds = (value) => {
    let list;
    if (Array.isArray(value)) list = value;
    else if (typeof value === "string") list = value.split(/[\s,]+/);
    else list = [];
    const entries = [...new Set(list.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean))];
    return { requested: entries.length, ids: entries.filter((id) => isObjectId(id)) };
};

const compactItem = (notification) => ({
    id: notification._id,
    type: notification.type,
    title: notification.title,
    body: notification.body || "",
    priority: notification.priority,
    read: Boolean(notification.readAt),
    createdAt: notification.createdAt,
    ...(notification.ui ? { ui: notification.ui } : {}),
});

export default [
    {
        name: "notifications_list",
        description:
            "List the user's in-app notifications (newest first) and their unread count: class schedule changes, "
            + "attendance alerts, drive/application/offer updates, training, job matches, system messages. Use it when "
            + "the user asks about notifications, alerts, updates or what is new. Each item has an `id` that "
            + "notifications_mark_read accepts. Opens the notifications panel.",
        roles: ALL_ROLES,
        confirm: false,
        parameters: {
            type: "object",
            properties: {
                unreadOnly: { type: "boolean", description: "Only unread notifications. Default false." },
                limit: { type: "integer", description: `How many notifications to return, 1-${LIST_MAX}. Default ${LIST_DEFAULT}.` },
            },
            required: [],
        },
        handler: async (args = {}, ctx = {}) => {
            const userId = requireUserId(ctx);
            const unreadOnly = toBoolean(args.unreadOnly);
            const { items, unread, nextBefore } = await listNotifications(userId, { limit: toLimit(args.limit), unreadOnly });

            let summary;
            if (items.length === 0) {
                summary = unreadOnly ? "You have no unread notifications." : "You have no notifications.";
            } else {
                const lines = items.map((notification, index) => {
                    const flags = `${notification.readAt ? "" : "[unread] "}${notification.priority === "high" ? "[important] " : ""}`;
                    const body = notification.body ? ` — ${snippet(notification.body, 140)}` : "";
                    return `${index + 1}. ${flags}${notification.title}${body} (${formatWhen(notification.createdAt, ctx.timezone)})`;
                });
                const heading = unreadOnly ? "Unread" : "Most recent";
                const more = nextBefore ? "; older ones are in the notifications panel" : "";
                summary = `You have ${plural(unread, "unread notification")}. ${heading} (${items.length}${more}):\n${lines.join("\n")}`;
            }

            return {
                summary,
                data: { unread, items: items.map(compactItem), hasMore: Boolean(nextBefore) },
                ui: { panel: "notifications" },
            };
        },
    },
    {
        name: "notifications_mark_read",
        description:
            "Mark the user's notifications as read: pass `ids` (from notifications_list) for specific ones, or "
            + "`all: true` to clear every unread notification.",
        roles: ALL_ROLES,
        confirm: false,
        parameters: {
            type: "object",
            properties: {
                ids: {
                    type: "array",
                    items: { type: "string" },
                    description: "Notification ids returned by notifications_list.",
                },
                all: { type: "boolean", description: "true marks every unread notification as read." },
            },
            required: [],
        },
        handler: async (args = {}, ctx = {}) => {
            const userId = requireUserId(ctx);

            if (toBoolean(args.all)) {
                const { updated } = await markAllRead(userId);
                const unread = await countUnread(userId);
                return {
                    summary: updated > 0
                        ? `Marked ${plural(updated, "notification")} as read.`
                        : "You had no unread notifications.",
                    data: { updated, unread },
                };
            }

            const { requested, ids } = parseIds(args.ids);
            if (ids.length === 0) {
                throw fail(400, "Pass notification ids from notifications_list, or all: true to mark everything read.", "VALIDATION", {
                    field: "ids",
                });
            }
            if (requested > MARK_MAX_IDS) {
                throw fail(400, `Pass at most ${MARK_MAX_IDS} ids, or all: true.`, "VALIDATION", { field: "ids" });
            }

            const { updated, found } = await markManyRead(userId, ids);
            if (found === 0) throw fail(404, "None of those notifications exist in your inbox.", "NOT_FOUND");
            const unread = await countUnread(userId);
            let summary = updated > 0
                ? `Marked ${plural(updated, "notification")} as read.`
                : "Those notifications were already read.";
            if (found < requested) summary += ` ${plural(requested - found, "id")} did not match your notifications.`;
            summary += ` ${plural(unread, "unread notification")} left.`;
            return { summary, data: { updated, unread } };
        },
    },
];
