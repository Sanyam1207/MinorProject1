// Notifications API (FRONTEND.md §14.3, NOTIFICATIONS.md).
import { http } from "../http.js";

const id = (value) => encodeURIComponent(String(value ?? ""));

const PRIORITIES = new Set(["low", "normal", "high"]);

/** Normalise one notification so components never meet `undefined` fields. */
export const normalizeNotification = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const notificationId = raw._id ?? raw.id;
  if (!notificationId) return null;
  return {
    ...raw,
    _id: String(notificationId),
    type: typeof raw.type === "string" ? raw.type : "system",
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    priority: PRIORITIES.has(raw.priority) ? raw.priority : "normal",
    ui: raw.ui && typeof raw.ui === "object" && typeof raw.ui.panel === "string" ? raw.ui : null,
    readAt: raw.readAt ?? null,
    createdAt: raw.createdAt ?? null,
  };
};

const normalizeList = (items) => (Array.isArray(items) ? items.map(normalizeNotification).filter(Boolean) : []);

export async function listNotifications({ limit = 30, before, unreadOnly } = {}) {
  const params = { limit };
  if (before) params.before = before;
  if (unreadOnly) params.unreadOnly = true;
  const data = await http.get("/notifications", { params });
  const items = normalizeList(Array.isArray(data) ? data : data?.items);
  return {
    items,
    unread: Number.isFinite(Number(data?.unread)) ? Number(data.unread) : items.filter((n) => !n.readAt).length,
    nextBefore: data?.nextBefore ?? null,
  };
}

export async function getUnreadCount() {
  const data = await http.get("/notifications/unread-count");
  const value = typeof data === "number" ? data : Number(data?.unread);
  return Number.isFinite(value) ? value : 0;
}

export async function markNotificationRead(notificationId) {
  const data = await http.post(`/notifications/${id(notificationId)}/read`, {});
  return normalizeNotification(data?.notification ?? data);
}

export async function markAllNotificationsRead() {
  const data = await http.post("/notifications/read-all", {});
  return { updated: Number(data?.updated) || 0 };
}

export async function deleteNotification(notificationId) {
  await http.delete(`/notifications/${id(notificationId)}`);
}

export async function getPushPublicKey() {
  const data = await http.get("/notifications/push/public-key");
  const publicKey = typeof data?.publicKey === "string" && data.publicKey ? data.publicKey : null;
  return { enabled: Boolean(data?.enabled) && Boolean(publicKey), publicKey };
}

export async function subscribePush(subscription) {
  await http.post("/notifications/push/subscribe", { subscription });
}

export async function unsubscribePush(endpoint) {
  await http.post("/notifications/push/unsubscribe", { endpoint });
}

const normalizePreferences = (data) => ({
  email: data?.email !== false,
  push: data?.push !== false,
  mutedTypes: Array.isArray(data?.mutedTypes) ? data.mutedTypes.filter((type) => typeof type === "string") : [],
});

export async function getNotificationPreferences() {
  const data = await http.get("/notifications/preferences");
  return normalizePreferences(data?.preferences ?? data);
}

export async function updateNotificationPreferences(prefs) {
  const data = await http.put("/notifications/preferences", normalizePreferences(prefs));
  return normalizePreferences(data?.preferences ?? data);
}
