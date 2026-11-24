import { ArrowLeft, Lock } from "lucide-react";
import { MODE_DEFS, defaultModeFor, roleLabel } from "../workspace/modes.js";

/** Shown only if a mode the role can't use is somehow active (FRONTEND.md §4.2). */
export default function AccessDeniedView({ user, attemptedMode, onReturnToApprovedMode }) {
  const role = user?.role || "student";
  const attemptedLabel = MODE_DEFS[attemptedMode]?.label ?? attemptedMode ?? "this mode";
  const homeLabel = MODE_DEFS[defaultModeFor(role)]?.label ?? "your workspace";

  return (
    <div className="card-stark animate-fadeIn space-y-5 border-2 border-black bg-white p-5 sm:p-8">
      <div className="flex items-start gap-3 border-2 border-black bg-red-100 p-4">
        <Lock className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-lg font-black uppercase tracking-tight">ACCESS DENIED: {String(attemptedLabel).toUpperCase()}</h2>
          <p className="mt-1 text-xs font-semibold text-gray-800">
            Your account{user?.email ? <> (<span className="break-all font-mono">{user.email}</span>)</> : null} is a{" "}
            <span className="font-black">{roleLabel(role)}</span> account, which can&apos;t open {attemptedLabel}.
          </p>
        </div>
      </div>
      <button type="button" onClick={onReturnToApprovedMode} className="btn-primary min-h-11 px-4 py-2 text-xs">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        RETURN TO {homeLabel.toUpperCase()}
      </button>
    </div>
  );
}
