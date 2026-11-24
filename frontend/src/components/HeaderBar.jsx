import { Menu } from "lucide-react";
import ModeDropdown from "./ModeDropdown.jsx";
import NotificationBell from "../features/notifications/NotificationBell.jsx";
import { APP_INITIALS, APP_NAME } from "../lib/config.js";

/**
 * App header (FRONTEND.md §4.2). Phone: row 1 = brand + bell + menu, row 2 =
 * full-width mode selector. ≥ sm: one row.
 */
export default function HeaderBar({ activeMode, setActiveMode, user, onOpenDrawer }) {
  const subtitle = user?.collegeName || "Placements · Attendance · Careers";
  return (
    <header className="sticky top-0 z-40 shrink-0 border-b-2 border-black bg-white px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:px-4 sm:py-3">
      <div className="mx-auto flex max-w-7xl flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="shrink-0 border-2 border-black bg-black px-2 py-0.5 text-lg font-black text-white sm:text-xl" aria-hidden="true">
              {APP_INITIALS}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-extrabold uppercase leading-tight tracking-tight sm:text-lg">{APP_NAME}</h1>
              <p className="truncate text-[11px] font-semibold text-gray-600 sm:text-xs">{subtitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:hidden">
            <NotificationBell />
            <button type="button" onClick={onOpenDrawer} aria-label="Open menu" className="btn-primary h-10 w-10 justify-center p-0">
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <ModeDropdown activeMode={activeMode} setActiveMode={setActiveMode} userRole={user?.role} />

        <div className="hidden items-center gap-2 sm:flex">
          <NotificationBell />
          <button type="button" onClick={onOpenDrawer} title="Menu, history and settings" className="btn-primary h-10 px-3 text-xs">
            <Menu className="h-4 w-4" aria-hidden="true" />
            <span className="font-extrabold tracking-wider">MENU</span>
          </button>
        </div>
      </div>
    </header>
  );
}
