import { CalendarCheck, CircleCheckBig, KeyRound, ScanQrCode, TriangleAlert } from "lucide-react";
import { useNow } from "../../../ui/index.js";

const TONES = {
  info: { box: "bg-green-100", Icon: CircleCheckBig },
  warn: { box: "bg-yellow-100", Icon: TriangleAlert },
  error: { box: "bg-red-100", Icon: TriangleAlert },
};

function RetryButton({ label, waitUntil, onRetry }) {
  const now = useNow(1000);
  const remaining = waitUntil ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0;
  return (
    <button type="button" onClick={onRetry} disabled={remaining > 0} className="btn-primary min-h-11 flex-1 justify-center text-xs disabled:opacity-50">
      <ScanQrCode className="h-3.5 w-3.5" aria-hidden="true" />
      {remaining > 0 ? `WAIT ${remaining}s` : label}
    </button>
  );
}

/** A scan that did not succeed (or was already marked): message + next steps. */
export default function ScanOutcome({ view, at, onRetry, retryLabel = "SCAN AGAIN", onJoinCourse, onOpenAttendance, onDone }) {
  const tone = TONES[view?.tone] ?? TONES.error;
  const Icon = tone.Icon;
  const waitUntil = view?.waitSeconds && at ? at + view.waitSeconds * 1000 : null;
  const showRetry = onRetry && view?.code !== "ALREADY_MARKED" && view?.code !== "DEVICE_ALREADY_USED";

  return (
    <div role="alert" className="animate-fadeIn flex flex-col items-center gap-4 text-center">
      <div className={`flex h-20 w-20 items-center justify-center border-2 border-black shadow-[4px_4px_0_0_#000] ${tone.box}`}>
        <Icon className="h-10 w-10" aria-hidden="true" />
      </div>
      <div className="max-w-sm">
        <h2 className="text-base font-black uppercase tracking-tight sm:text-lg">{view?.title ?? "COULDN'T MARK ATTENDANCE"}</h2>
        <p className="mt-2 text-xs font-semibold text-gray-700">{view?.message}</p>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row">
        {view?.joinCourse && onJoinCourse && (
          <button type="button" onClick={onJoinCourse} className="btn-primary min-h-11 flex-1 justify-center text-xs">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> JOIN A COURSE
          </button>
        )}
        {showRetry && <RetryButton label={retryLabel} waitUntil={waitUntil} onRetry={onRetry} />}
        {onOpenAttendance && (
          <button type="button" onClick={onOpenAttendance} className="btn-secondary min-h-11 flex-1 justify-center text-xs">
            <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" /> OPEN MY ATTENDANCE
          </button>
        )}
        {onDone && !showRetry && (
          <button type="button" onClick={onDone} className="btn-secondary min-h-11 flex-1 justify-center text-xs">
            DONE
          </button>
        )}
      </div>
    </div>
  );
}
