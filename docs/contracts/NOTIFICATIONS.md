# Contract — Notifications (in-app + realtime + email + web push)

Owner module: `backend/src/modules/notifications/`. Mounted at `/api/v1/notifications` (all routes `verifyJWT`).
Every other module sends notifications ONLY through `notify()` from
`backend/src/modules/notifications/notify.js` — never by writing the model directly.

## Model `Notification` (`notifications`)
| field | type | notes |
|---|---|---|
| user | ObjectId→User, required, index | recipient |
| type | String, required | dotted namespace, e.g. `attendance.scheduled`, `attendance.cancelled`, `attendance.rescheduled`, `attendance.reminder`, `attendance.live`, `attendance.marked`, `attendance.low`, `placement.drive.new`, `placement.application.status`, `placement.offer.new`, `placement.offer.updated`, `training.new`, `system` |
| title | String, required, ≤ 140 | |
| body | String, ≤ 1000 | |
| ui | Object | a UI action (see UI-ACTIONS contract) opened when the notification is clicked, e.g. `{panel:"attendance.student"}` |
| data | Mixed | small structured payload (ids) |
| priority | enum `low` \| `normal` \| `high` | `high` = toast + push even if the app is focused |
| readAt | Date | null = unread |
| dedupeKey | String | optional; unique per user (partial index) so retries never duplicate (e.g. `reminder:<sessionId>`) |
| createdAt | Date | TTL index: auto-delete after 90 days |

## Service API (`notify.js`)
```js
// Fan-out to many users; returns {created: n}
await notify(userIds /* ObjectId|string|array */, {
  type, title, body, ui, data, priority = "normal",
  dedupeKey,            // optional; combined per-user
  email = false,        // also send email if SMTP configured (uses services/mail.service.js)
  push = true,          // web push if VAPID configured and user subscribed
});
```
Behaviour: insertMany (ordered:false, ignore duplicate dedupeKey errors) → emit `notification:new` with the
saved document to room `user:<id>` and an updated `notification:count` `{unread}` → web push (best effort,
remove 404/410 subscriptions) → optional email (best effort). Failures in push/email never throw.

## REST (`/api/v1/notifications`)
- `GET /?limit=30&before=<iso>&unreadOnly=true` → `{items:[Notification], unread: n, nextBefore: iso|null}`
- `GET /unread-count` → `{unread}`
- `POST /:id/read` → `{notification}`; `POST /read-all` → `{updated}`
- `DELETE /:id` → `{deleted: true}`
- Web push: `GET /push/public-key` → `{enabled: bool, publicKey}`; `POST /push/subscribe` `{subscription}` (stores on `PushSubscription` model `{user, endpoint unique, keys:{p256dh, auth}, userAgent}`); `POST /push/unsubscribe` `{endpoint}`.
- Preferences: `GET /preferences` / `PUT /preferences` `{email: bool, push: bool, mutedTypes: [prefix]}` stored on `User.notificationPreferences`.

## Socket
Server → client on room `user:<userId>` (every authenticated socket auto-joins it on connect):
- `notification:new` `{notification}`
- `notification:count` `{unread}`

## Agent tools
`notifications_list` (`{unreadOnly?, limit?}`), `notifications_mark_read` (`{ids?: string[], all?: boolean}`), and the generic UI tool `open_panel` lives in AGENT-TOOLS.
