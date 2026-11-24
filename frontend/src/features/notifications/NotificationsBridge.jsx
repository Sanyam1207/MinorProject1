import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import toast from "react-hot-toast";
import { ArrowRight, X } from "lucide-react";
import { normalizeNotification } from "../../lib/api/notifications.js";
import { useOnSocketConnect, useSocketEvent } from "../../lib/realtime.js";
import { parsePanelUrl } from "../../workspace/deepLink.js";
import { applyUiActions } from "../../workspace/uiActions.js";
import { notificationReceived, unreadCountChanged } from "./notificationsSlice.js";
import { fetchUnreadCount, loadPreferences, markRead } from "./thunks.js";

const TOAST_DURATION = { high: 8000, normal: 5000 };

const isMuted = (type, mutedTypes) =>
  Array.isArray(mutedTypes) && mutedTypes.some((prefix) => typeof prefix === "string" && prefix && String(type).startsWith(prefix));

/** high → always; normal → only while the tab is visible; low → never (FRONTEND.md §9.3). */
const shouldToast = (notification, mutedTypes) => {
  if (isMuted(notification.type, mutedTypes)) return false;
  if (notification.priority === "high") return true;
  if (notification.priority === "low") return false;
  return typeof document !== "undefined" && document.visibilityState === "visible";
};

function NotificationToast({ toastInstance, notification, onOpen }) {
  return (
    <div
      role="status"
      className={`w-[min(92vw,380px)] border-2 border-black bg-white p-3 text-black shadow-[4px_4px_0_0_#000] ${toastInstance.visible ? "animate-fadeIn" : "opacity-0"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-black uppercase">{notification.title || "Notification"}</div>
          {notification.body && <p className="mt-0.5 line-clamp-3 text-[11px] font-medium text-gray-700">{notification.body}</p>}
        </div>
        <button type="button" aria-label="Dismiss" onClick={() => toast.dismiss(toastInstance.id)} className="shrink-0 p-1 hover:bg-gray-100">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {notification.ui && (
        <button
          type="button"
          onClick={() => {
            onOpen(notification);
            toast.dismiss(toastInstance.id);
          }}
          className="btn-primary mt-2 min-h-9 px-2 py-1 text-[10px]"
        >
          OPEN <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * Realtime notifications glue, mounted once in the app shell while signed in:
 * socket events → Redux + toasts, unread re-sync on (re)connect, and
 * service-worker "open-url" messages (push clicks on a focused window).
 */
export default function NotificationsBridge() {
  const dispatch = useDispatch();
  const mutedTypes = useSelector((state) => state.notifications.preferences?.mutedTypes);
  const mutedRef = useRef(mutedTypes);
  useEffect(() => {
    mutedRef.current = mutedTypes;
  }, [mutedTypes]);

  useEffect(() => {
    // Mute rules for toasts; best effort (the inbox works without them).
    dispatch(loadPreferences()).catch(() => {});
  }, [dispatch]);

  const open = (notification) => {
    if (notification.ui) applyUiActions([notification.ui], { source: "notification" });
    if (!notification.readAt) dispatch(markRead(notification._id));
  };

  useSocketEvent("notification:new", (payload) => {
    const notification = normalizeNotification(payload?.notification ?? payload);
    if (!notification) return;
    dispatch(notificationReceived(notification));
    if (!shouldToast(notification, mutedRef.current)) return;
    toast.custom((instance) => <NotificationToast toastInstance={instance} notification={notification} onOpen={open} />, {
      id: `notification:${notification._id}`,
      duration: TOAST_DURATION[notification.priority] ?? TOAST_DURATION.normal,
    });
  });

  useSocketEvent("notification:count", (payload) => {
    dispatch(unreadCountChanged(typeof payload === "number" ? payload : payload?.unread));
  });

  useOnSocketConnect(() => {
    dispatch(fetchUnreadCount());
  });

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
    const onMessage = (event) => {
      if (event.data?.type !== "open-url" || typeof event.data.url !== "string") return;
      const link = parsePanelUrl(event.data.url);
      if (!link) return;
      applyUiActions([{ panel: link.panel, params: link.params }], { source: "deeplink" });
      if (link.nid) dispatch(markRead(link.nid));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [dispatch]);

  return null;
}
