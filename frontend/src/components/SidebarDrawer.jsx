import { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronRight,
  Flag,
  History,
  KeyRound,
  LogOut,
  MessageSquare,
  MessageSquareText,
  Plus,
  Settings,
  SlidersHorizontal,
  User,
  X,
} from "lucide-react";
import { useNow } from "../ui/useNow.js";
import { roleLabel } from "../workspace/modes.js";

const cleanPreview = (text = "") =>
  String(text)
    .replace(/[#*_`>]/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/g, " ")
    .trim();

const HISTORY_GROUPS = ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"];

const historyGroup = (value, todayStart) => {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "Older";
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  const daysAgo = Math.floor((todayStart - day.getTime()) / 86400000);
  if (daysAgo <= 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo <= 7) return "Previous 7 Days";
  if (daysAgo <= 30) return "Previous 30 Days";
  return "Older";
};

const ACCOUNT_BADGE = {
  student: "STUDENT ACCOUNT",
  teacher: "FACULTY ACCOUNT",
  tpo: "TPO ACCOUNT",
  admin: "ADMIN ACCOUNT",
  company: "RECRUITER ACCOUNT",
  alumni: "ALUMNI ACCOUNT",
};

function MenuButton({ icon: Icon, label, onClick, tone = "default" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-11 w-full items-center justify-between gap-2 border-[1.5px] border-black px-3 py-2 text-left text-xs font-black uppercase transition-colors ${tone === "accent" ? "bg-yellow-100 hover:bg-yellow-200" : "bg-white hover:bg-gray-100"}`}
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {label}
      </span>
      <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </button>
  );
}

/**
 * Right drawer: chat history, account box and settings shortcuts (FRONTEND.md §9.7).
 * Every settings action opens a panel/overlay through the callbacks.
 */
export default function SidebarDrawer({
  isOpen,
  onClose,
  user,
  onLogout,
  chatSessions = [],
  onSelectChat,
  onNewChat,
  onOpenPanel,
  onChangePassword,
}) {
  const [isClosing, setIsClosing] = useState(false);
  const closeTimer = useRef(null);
  const panelRef = useRef(null);
  const now = useNow(60000);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen && !isClosing) return null;

  const closeThen = (callback) => {
    setIsClosing(true);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setIsClosing(false);
      onClose?.();
      callback?.();
    }, 220);
  };

  const history = chatSessions.slice(0, 30).map((session) => ({
    sessionId: session.sessionId,
    title: session.title,
    date: session.updatedAt || session.createdAt,
  }));
  const grouped = HISTORY_GROUPS.map((label) => ({
    label,
    items: history.filter((item) => historyGroup(item.date, todayStart) === label),
  })).filter((group) => group.items.length > 0);

  const role = user?.role || "student";
  const isStudent = role === "student";
  const detailLine = isStudent
    ? [user?.branch, user?.cgpa !== null && user?.cgpa !== undefined && user?.cgpa !== "" ? `CGPA ${user.cgpa}` : null].filter(Boolean).join(" · ")
    : [user?.designation, user?.department].filter(Boolean).join(" · ");

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        onClick={() => closeThen()}
        aria-hidden="true"
        className={`fixed inset-0 bg-black/40 ${isClosing ? "animate-fade-overlay-out" : "animate-fade-overlay"}`}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={`relative z-10 flex h-full w-full max-w-md flex-col overflow-hidden border-l-2 border-black bg-white shadow-2xl outline-none sm:w-[400px] ${isClosing ? "animate-drawer-slide-out" : "animate-drawer-slide"}`}
      >
        <div className="flex items-center justify-between border-b-2 border-black bg-gray-50 p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-2">
            <div className="bg-black p-1.5 text-white">
              <Settings className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-sm font-black uppercase tracking-tight">Menu</h2>
              <p className="text-[11px] font-semibold text-gray-600">Chat history, account & settings</p>
            </div>
          </div>
          <button type="button" onClick={() => closeThen()} aria-label="Close menu" className="btn-secondary p-1.5">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {user && (
            <div className="card-stark animate-item-up space-y-2 border-[1.5px] border-black bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="badge-stark bg-green-200 text-[10px]">{ACCOUNT_BADGE[role] ?? `${roleLabel(role).toUpperCase()} ACCOUNT`}</span>
                {detailLine && <span className="truncate font-mono text-[10px] font-bold text-gray-500">{detailLine}</span>}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-black uppercase">{user.name || "Your account"}</div>
                {user.email && <div className="truncate font-mono text-xs text-gray-600">{user.email}</div>}
              </div>
              <button type="button" onClick={() => closeThen(() => onOpenPanel?.("profile"))} className="btn-secondary min-h-11 w-full justify-center py-1.5 text-xs sm:min-h-0">
                <User className="h-3.5 w-3.5" aria-hidden="true" /> EDIT PROFILE
              </button>
            </div>
          )}

          <div className="animate-item-up space-y-2" style={{ animationDelay: "40ms" }}>
            <MenuButton icon={Bell} label="Notifications" onClick={() => closeThen(() => onOpenPanel?.("notifications"))} />
            <MenuButton icon={SlidersHorizontal} label="Notification settings" onClick={() => closeThen(() => onOpenPanel?.("notifications", { tab: "preferences" }))} />
            {isStudent && <MenuButton icon={KeyRound} label="AI keys (BYOK)" onClick={() => closeThen(() => onOpenPanel?.("settings.ai-keys"))} />}
            <MenuButton icon={KeyRound} label="Change password" onClick={() => closeThen(onChangePassword)} />
            <MenuButton icon={Flag} label="Report an issue" tone="accent" onClick={() => closeThen(() => onOpenPanel?.("report-issue"))} />
          </div>

          <div className="animate-item-up" style={{ animationDelay: "80ms" }}>
            <div className="mb-3 flex items-center justify-between gap-2 border-b-2 border-black pb-2">
              <div className="flex min-w-0 items-center gap-1.5 text-xs font-extrabold uppercase">
                <History className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Recent chats</span>
              </div>
              {onNewChat && (
                <button type="button" onClick={() => closeThen(onNewChat)} className="btn-secondary px-2 py-1 text-[10px]">
                  <Plus className="h-3 w-3" aria-hidden="true" /> NEW CHAT
                </button>
              )}
            </div>
            <div className="max-h-[42vh] overflow-y-auto pr-1">
              {grouped.map((group) => (
                <div key={group.label} className="mb-4 last:mb-0">
                  <h3 className="mb-1.5 px-2 text-[10px] font-bold text-gray-500">{group.label}</h3>
                  <div className="space-y-0.5">
                    {group.items.map((item, index) => (
                      <button
                        type="button"
                        key={item.sessionId || `${group.label}-${index}`}
                        title={cleanPreview(item.title)}
                        onClick={() => closeThen(() => onSelectChat?.(item.sessionId))}
                        className="flex min-h-10 w-full min-w-0 items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-gray-200"
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-600" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800">
                          {cleanPreview(item.title) || "Untitled conversation"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {history.length === 0 && (
                <div className="flex flex-col items-center border-2 border-dashed border-gray-400 bg-gray-50 px-4 py-6 text-center">
                  <MessageSquareText className="mb-2 h-6 w-6 text-gray-400" aria-hidden="true" />
                  <div className="text-[11px] font-black uppercase">No conversations yet</div>
                  <p className="mt-1 max-w-52 text-[10px] font-medium text-gray-500">Ask the copilot something to start your history.</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t-2 border-black bg-gray-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => closeThen(onLogout)}
            className="btn-primary min-h-11 w-full justify-center border-black bg-red-600 py-2.5 text-xs text-white hover:bg-red-700"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            LOG OUT
          </button>
        </div>
      </aside>
    </div>
  );
}
