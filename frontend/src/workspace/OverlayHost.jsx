import { useCallback, useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import ProfileModal from "../components/ProfileModal.jsx";
import NotificationPanel from "../features/notifications/NotificationPanel.jsx";
import ReportIssueModal from "../features/help/ReportIssueModal.jsx";
import { userUpdated } from "../features/auth/session.js";
import { overlayClosed } from "../store/appContextSlice.js";
import { usePanel } from "./usePanel.js";

function NotificationsOverlay({ onClose }) {
  const panelRef = useRef(null);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(event) => {
        if (panelRef.current && !panelRef.current.contains(event.target)) onClose();
      }}
    >
      <div className="animate-fade-overlay absolute inset-0 bg-black/40 sm:bg-black/10" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 sm:inset-x-0 sm:bottom-auto sm:top-16">
        <div className="mx-auto flex h-full max-w-7xl justify-end sm:h-auto sm:px-4">
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            tabIndex={-1}
            className="animate-fadeIn pointer-events-auto flex h-full w-full flex-col overflow-hidden border-black bg-white outline-none sm:h-auto sm:max-h-[70vh] sm:w-[380px] sm:border-2 sm:shadow-[4px_4px_0_0_#000]"
          >
            <NotificationPanel onClose={onClose} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileOverlay({ user, onClose, onChangePassword }) {
  const dispatch = useDispatch();
  const { params } = usePanel("profile");
  return (
    <ProfileModal
      user={user}
      initialTab={params.tab}
      onClose={onClose}
      onProfileUpdated={(updated) => dispatch(userUpdated(updated))}
      onChangePassword={onChangePassword}
    />
  );
}

/** Renders the open overlay panel (UI-ACTIONS.md §3.7): notifications, profile, report-issue. */
export default function OverlayHost({ onChangePassword }) {
  const dispatch = useDispatch();
  const overlay = useSelector((state) => state.appContext.overlay);
  const user = useSelector((state) => state.appContext.user);
  const close = useCallback(() => dispatch(overlayClosed()), [dispatch]);

  if (overlay === "notifications") return <NotificationsOverlay onClose={close} />;
  if (overlay === "profile" && user) return <ProfileOverlay user={user} onClose={close} onChangePassword={onChangePassword} />;
  if (overlay === "report-issue") return <ReportIssueModal onClose={close} />;
  return null;
}
