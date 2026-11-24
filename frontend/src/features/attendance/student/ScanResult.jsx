import { CalendarCheck, CircleCheckBig, Clock } from "lucide-react";
import { STATUS_COLORS, formatDateTime, formatPercent, formatTime } from "../../../ui/index.js";

/**
 * Big confirmation after a successful scan (FRONTEND.md §13.2 ScanResult).
 * `result` = POST /scan response, or a partial one rebuilt from the
 * `attendance:confirmed` socket event (summary/markedAt may be null).
 */
export default function ScanResult({ result, onOpenAttendance, onDone, doneLabel = "DONE" }) {
  const status = result?.status === "late" ? "late" : "present";
  const course = result?.course ?? {};
  const session = result?.session ?? {};
  const summary = result?.summary ?? null;
  const percent = Number(summary?.percent);
  const hasPercent = summary && Number.isFinite(percent);

  return (
    <div role="status" aria-live="polite" className="animate-fadeIn flex flex-col items-center gap-4 text-center">
      <div className={`flex h-24 w-24 items-center justify-center border-2 border-black shadow-[4px_4px_0_0_#000] ${STATUS_COLORS.attendance[status]}`}>
        {status === "late" ? <Clock className="h-12 w-12" aria-hidden="true" /> : <CircleCheckBig className="h-12 w-12" aria-hidden="true" />}
      </div>

      <div>
        <div className="text-[10px] font-black uppercase tracking-widest text-gray-600">Attendance marked</div>
        <div className="mt-1 text-3xl font-black uppercase tracking-tight sm:text-4xl">{status === "late" ? "LATE" : "PRESENT"}</div>
        {status === "late" && <p className="mt-1 text-[11px] font-semibold text-gray-700">You scanned after the late cut-off for this class.</p>}
      </div>

      <div className="w-full max-w-sm border-2 border-black bg-white p-4 text-left">
        <div className="flex flex-wrap items-center gap-2">
          {course.code && <span className="badge-stark bg-black font-mono text-[11px] text-white">{course.code}</span>}
          <span className="text-sm font-black uppercase">{course.name || "Your class"}</span>
        </div>
        {session.topic && <p className="mt-1 text-xs font-semibold text-gray-700">{session.topic}</p>}
        <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <dt className="font-black uppercase text-gray-500">Marked at</dt>
            <dd className="font-bold tabular-nums">{result?.markedAt ? formatTime(result.markedAt) : "Just now"}</dd>
          </div>
          {session.startsAt && (
            <div>
              <dt className="font-black uppercase text-gray-500">Class</dt>
              <dd className="font-bold tabular-nums">{formatDateTime(session.startsAt)}</dd>
            </div>
          )}
        </dl>
        {hasPercent && (
          <div className="mt-3 border-t-[1.5px] border-black pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-black uppercase text-gray-600">This course now</span>
              <span className="text-lg font-black tabular-nums">{formatPercent(percent, percent % 1 ? 1 : 0)}</span>
            </div>
            <div className="mt-1 h-2.5 border border-black bg-gray-100">
              <div className="h-full bg-green-200" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
            </div>
            <div className="mt-1 text-[11px] font-bold tabular-nums text-gray-700">
              {summary.attended}/{summary.held} classes attended
            </div>
          </div>
        )}
      </div>

      <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row">
        {onOpenAttendance && (
          <button type="button" onClick={onOpenAttendance} className="btn-secondary min-h-11 flex-1 justify-center text-xs">
            <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" /> OPEN MY ATTENDANCE
          </button>
        )}
        {onDone && (
          <button type="button" onClick={onDone} className="btn-primary min-h-11 flex-1 justify-center text-xs">
            {doneLabel}
          </button>
        )}
      </div>
    </div>
  );
}
