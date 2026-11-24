// Notification thunks (FRONTEND.md §9.2–§9.4).
import { errorMessage } from "../../lib/http.js";
import {
  deleteNotification,
  getNotificationPreferences,
  getPushPublicKey,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribePush,
  unsubscribePush,
  updateNotificationPreferences,
} from "../../lib/api/notifications.js";
import { toastError } from "../../ui/toast.js";
import {
  allMarkedRead,
  notificationMarkedRead,
  notificationRemoved,
  notificationsFailed,
  notificationsLoaded,
  notificationsLoading,
  preferencesLoaded,
  pushStateChanged,
  unreadCountChanged,
} from "./notificationsSlice.js";
import {
  getCurrentSubscription,
  isPushSupported,
  notificationPermission,
  registerServiceWorker,
  subscribeWithKey,
} from "./push.js";

export const fetchNotifications = ({ before } = {}) => async (dispatch) => {
  dispatch(notificationsLoading());
  try {
    const result = await listNotifications({ before });
    dispatch(notificationsLoaded({ ...result, append: Boolean(before) }));
    return result;
  } catch (error) {
    dispatch(notificationsFailed(errorMessage(error, "Unable to load notifications")));
    return null;
  }
};

export const fetchUnreadCount = () => async (dispatch) => {
  try {
    const unread = await getUnreadCount();
    dispatch(unreadCountChanged(unread));
    return unread;
  } catch {
    return null;
  }
};

/** Optimistic: the dot disappears at once; the server call is best effort. */
export const markRead = (notificationId) => async (dispatch) => {
  if (!notificationId) return;
  dispatch(notificationMarkedRead({ id: notificationId, readAt: new Date().toISOString() }));
  try {
    await markNotificationRead(notificationId);
  } catch {
    // The next unread-count sync corrects the badge.
  }
};

export const markAllRead = () => async (dispatch) => {
  try {
    await markAllNotificationsRead();
    dispatch(allMarkedRead(new Date().toISOString()));
  } catch (error) {
    toastError(error, "Unable to mark notifications as read");
  }
};

export const removeNotification = (notificationId) => async (dispatch) => {
  dispatch(notificationRemoved(notificationId));
  try {
    await deleteNotification(notificationId);
  } catch (error) {
    toastError(error, "Unable to delete the notification");
    dispatch(fetchNotifications());
  }
};

export const loadPreferences = () => async (dispatch) => {
  const preferences = await getNotificationPreferences();
  dispatch(preferencesLoaded(preferences));
  return preferences;
};

/** Throws on failure (the preferences tab shows the error). */
export const savePreferences = (preferences) => async (dispatch) => {
  const saved = await updateNotificationPreferences(preferences);
  dispatch(preferencesLoaded(saved));
  return saved;
};

/** Whether the server has VAPID keys (best effort; `null` = unknown). */
export const checkPushServer = () => async (dispatch) => {
  try {
    const { enabled } = await getPushPublicKey();
    dispatch(pushStateChanged({ serverEnabled: enabled }));
    return enabled;
  } catch {
    return null;
  }
};

/**
 * Opt in to web push on THIS device. Must start from a click: the permission
 * prompt is requested first, while the user gesture is still active.
 */
export const enablePush = () => async (dispatch) => {
  if (!isPushSupported()) {
    throw new Error("This browser can't receive push notifications here. Use https or add the app to your Home Screen.");
  }
  const permissionPromise = window.Notification.requestPermission();
  const { enabled, publicKey } = await getPushPublicKey();
  dispatch(pushStateChanged({ serverEnabled: enabled }));
  const permission = await permissionPromise;
  dispatch(pushStateChanged({ permission }));
  if (!enabled || !publicKey) throw new Error("Push is not configured on the server");
  if (permission !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in your browser settings and try again.");
  }
  const registration = await registerServiceWorker();
  if (!registration) throw new Error("The notification service could not start in this browser.");
  const subscription = await subscribeWithKey(registration, publicKey);
  await subscribePush(subscription.toJSON());
  dispatch(pushStateChanged({ subscribed: true }));
  return true;
};

/**
 * Stop push on THIS device: tell the server (best effort) and drop the
 * browser subscription so a shared phone stops receiving the previous user's alerts.
 */
export const disablePush = ({ notifyServer = true } = {}) => async (dispatch) => {
  const subscription = await getCurrentSubscription();
  if (subscription) {
    if (notifyServer) {
      try {
        await unsubscribePush(subscription.endpoint);
      } catch {
        // The push service will 404/410 and the server prunes the subscription.
      }
    }
    try {
      await subscription.unsubscribe();
    } catch {
      // ignore
    }
  }
  dispatch(pushStateChanged({ subscribed: false }));
};

/** Silent sync on boot/login: never prompts; re-registers an existing subscription. */
export const syncPushState = () => async (dispatch) => {
  if (!isPushSupported()) {
    dispatch(pushStateChanged({ supported: false }));
    return;
  }
  const permission = notificationPermission();
  dispatch(pushStateChanged({ supported: true, permission }));
  dispatch(checkPushServer());
  if (permission !== "granted") return;
  try {
    await registerServiceWorker();
    const subscription = await getCurrentSubscription();
    if (subscription) {
      await subscribePush(subscription.toJSON()).catch(() => {});
      dispatch(pushStateChanged({ subscribed: true }));
    } else {
      dispatch(pushStateChanged({ subscribed: false }));
    }
  } catch {
    // Service worker registration can fail on odd browsers; push just stays off.
  }
};
