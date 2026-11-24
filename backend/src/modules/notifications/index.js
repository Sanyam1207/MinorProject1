// Module "notifications": in-app inbox + realtime + email + web push
// (docs/contracts/NOTIFICATIONS.md). Mounted at /api/v1/notifications.
//
// Sending — other modules import ONLY from ./notify.js, never the models:
//
//   import { notify, notifyRole, notifyUsersWhere } from "../notifications/notify.js";
//
//   await notify(userIds, { type, title, body, ui, data, priority, dedupeKey, email, push })
//     userIds   ObjectId | string | {_id} | an array or Set of those (invalid/duplicate ids ignored)
//     type      dotted namespace, e.g. "attendance.scheduled" (required, ≤ 100 chars)
//     title     required; cut to 140 chars. body: optional; cut to 1000 chars
//     ui        UI action {panel, params?} opened on click (UI-ACTIONS.md §11); id/data are not stored
//     data      small JSON payload (ids), ≤ 16 KB
//     priority  "low" | "normal" (default) | "high"
//     dedupeKey optional; unique per recipient, so retries never duplicate
//     email     default false; sent only to users who enabled email and did not mute the type
//     push      default true; web push when VAPID is configured (high: always; normal: only to
//               users without an open app; low: never)
//     → { created }  notifications actually inserted. Push/email run in the background and never throw.
//
//   await notifyRole(role | role[], payload, filter = {})   → { created, recipients }
//     every active user with the role(s), narrowed by an extra User filter, e.g.
//     notifyRole("student", payload, { college, branch: "CSE", passingYear: "2026" }).
//   await notifyUsersWhere(filter, payload, { batchSize = 500 })  → { created, recipients }
//     every active user matching a User query (announcements). Build filters from trusted values only.
//
//   flushDeliveries()            resolves when background push/email deliveries have finished
//                                (tests, scripts that exit right after notifying, graceful shutdown)
//   setPushSender(fn | null)     replace the web-push transport (tests); null restores it
//   setMailSender(fn | null)     replace the email transport (tests); null restores SMTP
//
// Environment: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (web push, optional);
// SMTP_* via core/mailer.js (email, optional); FRONTEND_URL (links in push payloads and emails).
//
// Realtime (room user:<id>): `notification:new` {notification}, `notification:count` {unread}.
// Agent tools: notifications_list, notifications_mark_read (./tools.js).
import router from "./routes.js";
import tools from "./tools.js";

export default {
    name: "notifications",
    mountPath: "/api/v1/notifications",
    router,
    tools,
};
