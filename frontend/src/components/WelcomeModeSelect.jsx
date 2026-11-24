import { ArrowRight } from "lucide-react";
import { MODE_DEFS, allowedModesFor, roleLabel } from "../workspace/modes.js";
import ModeIcon from "../workspace/ModeIcon.jsx";

/** First screen after a student signs in: one card per allowed mode (FRONTEND.md §4.2). */
export default function WelcomeModeSelect({ user, onModeSelected }) {
  const modes = allowedModesFor(user?.role).map((id) => MODE_DEFS[id]).filter(Boolean);
  const firstName = String(user?.name || "").trim().split(/\s+/)[0];

  return (
    <div className="card-stark animate-fadeIn space-y-6 border-2 border-black bg-white p-4 sm:p-6">
      <div className="flex flex-col items-start justify-between gap-3 border-2 border-black bg-black p-4 text-white sm:flex-row sm:items-center sm:p-5">
        <div className="min-w-0">
          <span className="badge-stark bg-yellow-200 text-[10px] text-black">{roleLabel(user?.role).toUpperCase()} ACCOUNT</span>
          <h2 className="mt-1 text-xl font-black uppercase tracking-tight">Welcome{firstName ? `, ${firstName}` : ""}!</h2>
          {user?.email && <p className="mt-0.5 break-all font-mono text-xs text-gray-300">{user.email}</p>}
        </div>
        <div className="text-[10px] font-extrabold uppercase text-gray-300">Choose where to start — switch any time from the header.</div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {modes.map((mode) => {
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => onModeSelected(mode.id)}
              className="card-stark group flex min-h-48 flex-col items-center justify-between gap-3 border-2 border-black bg-white p-5 text-center transition-all hover:-translate-y-0.5 hover:bg-gray-50"
            >
              <span className="bg-black p-3.5 text-white">
                <ModeIcon name={mode.icon} className="h-8 w-8" />
              </span>
              <span className="space-y-1.5">
                <span className="badge-stark bg-gray-100 text-[10px] uppercase">{mode.badge}</span>
                <span className="block text-base font-black uppercase tracking-tight group-hover:underline">{mode.label}</span>
                <span className="block text-xs font-medium text-gray-600">{mode.description}</span>
              </span>
              <span className="btn-primary w-full justify-center py-1.5 text-xs">
                OPEN {mode.label.toUpperCase()} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
