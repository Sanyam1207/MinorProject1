import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { BellOff, BellRing, CheckCheck, Inbox, LoaderCircle, Smartphone, X } from "lucide-react";
import ErrorState from "../../ui/ErrorState.jsx";
import LoadingState from "../../ui/LoadingState.jsx";
import Tabs from "../../ui/Tabs.jsx";
import { formatRelative } from "../../ui/format.js";
import { toastError, toastSuccess } from "../../ui/toast.js";
import { useNow } from "../../ui/useNow.js";
import { applyUiActions } from "../../workspace/uiActions.js";
import { usePanel } from "../../workspace/usePanel.js";
import NotificationPreferences from "./NotificationPreferences.jsx";
import { needsHomeScreenInstall } from "./push.js";
import { checkPushServer, enablePush, fetchNotifications, markAllRead, markRead, removeNotification } from "./thunks.js";

const PRIORITY_BAR = { high: "bg-red-500", normal: "bg-blue-400", low: "bg-gray-300" };
const TABS = [
  { id: "inbox", label: "Inbox" },
  { id: "preferences", label: "Preferences" },
];

function PushPrompt() {
  const dispatch = useDispatch();
  const push = useSelector((state) => state.notifications.push);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (push.supported && push.serverEnabled === null) dispatch(checkPushServer());
  }, [dispatch, push.supported, push.serverEnabled]);

  if (!push.supported) {
    if (!needsHomeScreenInstall()) return null;
    return (
      <div className="flex items-start gap-2 border-b-2 border-black bg-blue-50 px-3 py-2 text-[11px] font-bold">
        <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Add this app to your Home Screen to receive alerts.
      </div>
    );
  }
  if (!push.serverEnabled || push.permission !== "default" || push.subscribed) return null;

  const enable = async () => {
    setBusy(true);
    try {
      await dispatch(enablePush());
      toastSuccess("Alerts are on for this device");
    } catch (error) {
      toastError(error, "Couldn't turn on alerts");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 border-b-2 border-black bg-yellow-50 px-3 py-2">
      <span className="flex items-center gap-1.5 text-[11px] font-black uppercase">
        <BellRing className="h-3.5 w-3.5" aria-hidden="true" /> Get alerts on this device
      </span>
      <button type="button" onClick={enable} disabled={busy} className="btn-primary min-h-9 px-2 py-1 text-[10px] disabled:opacity-60">
        {busy && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />} ENABLE
      </button>
    </div>
  );
}

function NotificationRow({ notification, now, onOpen, onDelete }) {
  const unread = !notification.readAt;
  return (
    <li className={`group relative flex border-b border-gray-200 ${unread ? "bg-white" : "bg-gray-50"}`}>
      <span className={`w-1 shrink-0 ${PRIORITY_BAR[notification.priority] ?? PRIORITY_BAR.normal}`} aria-hidden="true" />
      <button type="button" onClick={() => onOpen(notification)} className="min-w-0 flex-1 px-3 py-2.5 text-left hover:bg-gray-100">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-xs ${unread ? "font-black" : "font-bold text-gray-700"}`}>{notification.title || "Notification"}</span>
            {notification.body && <span className="mt-0.5 line-clamp-2 block text-[11px] font-medium text-gray-600">{notification.body}</span>}
            <span className="mt-1 block text-[10px] font-bold uppercase text-gray-500">{formatRelative(notification.createdAt, now)}</span>
          </span>
          {unread && <span className="mt-1 h-2 w-2 shrink-0 bg-black" aria-label="Unread" />}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(notification)}
        aria-label={`Delete notification ${notification.title}`}
        className="flex w-10 shrink-0 items-center justify-center text-gray-500 hover:bg-red-50 hover:text-black"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

function InboxList() {
  const dispatch = useDispatch();
  const { items, unread, nextBefore, status, error, loaded } = useSelector((state) => state.notifications);
  const now = useNow(30000);

  useEffect(() => {
    if (!loaded) dispatch(fetchNotifications());
  }, [dispatch, loaded]);

  const open = (notification) => {
    if (!notification.readAt) dispatch(markRead(notification._id));
    if (notification.ui) applyUiActions([notification.ui], { source: "notification" });
  };

  if (!loaded && status !== "error") return <LoadingState label="LOADING NOTIFICATIONS…" />;
  if (!loaded && status === "error") return <div className="p-3"><ErrorState error={error} onRetry={() => dispatch(fetchNotifications())} /></div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b-2 border-black px-3 py-2">
        <span className="text-[10px] font-black uppercase text-gray-600 tabular-nums">{unread} unread</span>
        <button
          type="button"
          onClick={() => dispatch(markAllRead())}
          disabled={unread === 0}
          className="btn-secondary min-h-9 px-2 py-1 text-[10px] disabled:opacity-40"
        >
          <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> MARK ALL READ
        </button>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center">
          <Inbox className="mx-auto mb-2 h-7 w-7 text-gray-400" aria-hidden="true" />
          <div className="text-xs font-black uppercase">You're all caught up</div>
          <p className="mt-1 text-[11px] text-gray-500">Class reminders, drive updates and offers will show up here.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((notification) => (
            <NotificationRow
              key={notification._id}
              notification={notification}
              now={now}
              onOpen={open}
              onDelete={(item) => dispatch(removeNotification(item._id))}
            />
          ))}
          {nextBefore && (
            <li className="p-2 text-center">
              <button
                type="button"
                disabled={status === "loading"}
                onClick={() => dispatch(fetchNotifications({ before: nextBefore }))}
                className="btn-secondary min-h-9 px-3 py-1 text-[10px] disabled:opacity-50"
              >
                {status === "loading" && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />} LOAD MORE
              </button>
            </li>
          )}
          {status === "error" && (
            <li className="p-2 text-center text-[11px] font-bold text-red-700">{error}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Notifications overlay content (FRONTEND.md §9.3): INBOX / PREFERENCES. */
export default function NotificationPanel({ onClose }) {
  const { params, setParams } = usePanel("notifications");
  const tab = params.tab === "preferences" ? "preferences" : "inbox";
  const pushOff = useSelector((state) => state.notifications.push.permission === "denied");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b-2 border-black px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-2">
        <h2 className="flex items-center gap-1.5 text-sm font-black uppercase">
          {pushOff ? <BellOff className="h-4 w-4" aria-hidden="true" /> : <BellRing className="h-4 w-4" aria-hidden="true" />}
          Notifications
        </h2>
        <button type="button" onClick={onClose} aria-label="Close notifications" className="btn-secondary p-1.5">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="border-b-2 border-black px-3 py-2">
        <Tabs tabs={TABS} value={tab} onChange={(next) => setParams({ tab: next })} label="Notification views" />
      </div>
      {tab === "inbox" ? (
        <>
          <PushPrompt />
          <InboxList />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <NotificationPreferences />
        </div>
      )}
    </div>
  );
}
