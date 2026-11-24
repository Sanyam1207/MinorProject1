import { useDispatch, useSelector } from "react-redux";
import { Bell } from "lucide-react";
import { overlayClosed } from "../../store/appContextSlice.js";
import { openPanel } from "../../workspace/uiActions.js";

/** Header bell with the unread badge; toggles the notifications overlay. */
export default function NotificationBell() {
  const dispatch = useDispatch();
  const unread = useSelector((state) => state.notifications.unread);
  const open = useSelector((state) => state.appContext.overlay === "notifications");
  const label = unread > 0 ? `Notifications (${unread} unread)` : "Notifications";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={() => (open ? dispatch(overlayClosed()) : openPanel("notifications"))}
      className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center border-[1.5px] border-black transition-colors ${open ? "bg-black text-white" : "bg-white hover:bg-gray-100"}`}
    >
      <Bell className="h-4 w-4" aria-hidden="true" />
      {unread > 0 && (
        <span className="absolute -right-2 -top-2 min-w-5 border border-white bg-black px-1 text-center text-[10px] font-black leading-4 text-white tabular-nums">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
