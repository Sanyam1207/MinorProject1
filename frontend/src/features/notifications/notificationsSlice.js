// Notifications state (FRONTEND.md §9.2), mounted as `state.notifications`.
import { createSlice } from "@reduxjs/toolkit";
import { sessionEnded, sessionStarted } from "../auth/sessionSlice.js";

const pushDefaults = () => ({
  supported:
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    Boolean(window.isSecureContext),
  serverEnabled: null,
  permission: typeof Notification !== "undefined" ? Notification.permission : "default",
  subscribed: false,
});

const initialState = () => ({
  items: [],
  unread: 0,
  nextBefore: null,
  status: "idle",
  error: null,
  loaded: false,
  preferences: null,
  push: pushDefaults(),
});

const byNewest = (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));

const notificationsSlice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    notificationsLoading(state) {
      state.status = "loading";
      state.error = null;
    },
    notificationsFailed(state, action) {
      state.status = "error";
      state.error = action.payload || "Unable to load notifications";
    },
    /** payload: { items, unread, nextBefore, append } */
    notificationsLoaded(state, action) {
      const { items = [], unread, nextBefore = null, append = false } = action.payload || {};
      const merged = append ? [...state.items, ...items] : items;
      const seen = new Set();
      state.items = merged.filter((item) => (seen.has(item._id) ? false : seen.add(item._id))).sort(byNewest);
      if (Number.isFinite(unread)) state.unread = unread;
      state.nextBefore = nextBefore;
      state.status = "ready";
      state.error = null;
      state.loaded = true;
    },
    /** Realtime `notification:new` — prepend, dedupe by `_id`. */
    notificationReceived(state, action) {
      const notification = action.payload;
      if (!notification?._id) return;
      const exists = state.items.some((item) => item._id === notification._id);
      if (exists) return;
      state.items.unshift(notification);
      if (!notification.readAt) state.unread += 1;
    },
    unreadCountChanged(state, action) {
      const value = Number(action.payload);
      if (Number.isFinite(value) && value >= 0) state.unread = value;
    },
    /** payload: id or { id, readAt } */
    notificationMarkedRead(state, action) {
      const id = typeof action.payload === "object" ? action.payload?.id : action.payload;
      const readAt = (typeof action.payload === "object" && action.payload?.readAt) || new Date().toISOString();
      const item = state.items.find((entry) => entry._id === id);
      if (item && !item.readAt) {
        item.readAt = readAt;
        state.unread = Math.max(0, state.unread - 1);
      }
    },
    allMarkedRead(state, action) {
      const readAt = action.payload || new Date().toISOString();
      for (const item of state.items) if (!item.readAt) item.readAt = readAt;
      state.unread = 0;
    },
    notificationRemoved(state, action) {
      const index = state.items.findIndex((entry) => entry._id === action.payload);
      if (index === -1) return;
      const [removed] = state.items.splice(index, 1);
      if (!removed.readAt) state.unread = Math.max(0, state.unread - 1);
    },
    preferencesLoaded(state, action) {
      state.preferences = action.payload || null;
    },
    pushStateChanged(state, action) {
      state.push = { ...state.push, ...(action.payload || {}) };
    },
  },
  extraReducers: (builder) => {
    builder.addCase(sessionStarted, () => initialState()).addCase(sessionEnded, () => initialState());
  },
});

export const {
  notificationsLoading,
  notificationsFailed,
  notificationsLoaded,
  notificationReceived,
  unreadCountChanged,
  notificationMarkedRead,
  allMarkedRead,
  notificationRemoved,
  preferencesLoaded,
  pushStateChanged,
} = notificationsSlice.actions;

export const selectNotifications = (state) => state.notifications;
export const selectUnreadCount = (state) => state.notifications.unread;
export const selectPushState = (state) => state.notifications.push;
export const selectNotificationPreferences = (state) => state.notifications.preferences;

export default notificationsSlice.reducer;
