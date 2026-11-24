import { useState } from "react";
import { Download, LoaderCircle, Radio } from "lucide-react";
import { getSession, markRecord } from "../../../lib/api/attendance.js";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import { toastError, toastSuccess } from "../../../ui/toast.js";
import { useAsync } from "../../../ui/useAsync.js";
import { useNow } from "../../../ui/useNow.js";
import { openPanel } from "../../../workspace/index.js";
import { exportSessionCsv } from "./download.js";
import { teacherError } from "./errors.js";
import { istDayHeading, sessionStatus } from "./ist.js";
import { SessionMeta, SessionStats, SourceBadge } from "./parts.jsx";
import RosterTable from "./RosterTable.jsx";

/**
 * Roster + stats of one session with CSV export. `readOnly` (tpo/admin
 * oversight) hides manual marking and the live link.
 */
export default function SessionReportView({ sessionId, readOnly = false }) {
  const now = useNow(60000);
  const state = useAsync(() => getSession(sessionId), [sessionId], { enabled: Boolean(sessionId) });
  const [exporting, setExporting] = useState(false);
  const detail = state.data;

  if (state.loading && !detail) return <LoadingState label="LOADING REPORT…" />;
  if (state.error && !detail) return <ErrorState error={state.error} onRetry={state.reload} title="COULDN'T LOAD THIS CLASS" />;
  if (!detail?.session) return null;

  const { session, course, roster, stats } = detail;
  const status = sessionStatus(session, now);
  const canMark = !readOnly && (status === "live" || status === "ended");

  const onMark = async (studentId, value, note) => {
    try {
      const result = await markRecord(sessionId, { studentId, status: value, note });
      state.setData((current) =>
        current
          ? {
              ...current,
              stats: result.stats ?? current.stats,
              roster: current.roster.map((row) =>
                row.student?._id === studentId ? { ...row, record: { ...(row.record || {}), ...result.record, student: row.student } } : row,
              ),
            }
          : current,
      );
      toastSuccess(`Marked ${value}`);
    } catch (error) {
      toastError(teacherError(error, "Couldn't update attendance"));
      throw error;
    }
  };

  const onExport = async () => {
    setExporting(true);
    try {
      await exportSessionCsv(session, course);
    } catch (error) {
      toastError(teacherError(error, "Couldn't export the CSV"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 border-2 border-black p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm font-black">{course?.code ?? session.course?.code}</span>
            <span className="text-sm font-bold">{course?.name ?? session.course?.name}</span>
            <StatusBadge kind="session" status={status} />
            <SourceBadge source={session.source} />
          </div>
          <div className="text-xs font-black uppercase">{istDayHeading(session.startsAt)}</div>
          <SessionMeta session={session} />
          {course?.teacher?.name && readOnly && <div className="text-[11px] font-semibold text-gray-600">Teacher: {course.teacher.name}</div>}
          {status === "cancelled" && session.cancelReason && <p className="text-[11px] font-semibold text-red-700">Cancelled: {session.cancelReason}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!readOnly && status === "live" && (
            <button type="button" onClick={() => openPanel("teacher.live", { sessionId })} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" /> OPEN LIVE
            </button>
          )}
          <button type="button" onClick={onExport} disabled={exporting} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
            {exporting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
            EXPORT CSV
          </button>
        </div>
      </div>
      <SessionStats stats={stats} />
      {status === "scheduled" && <p className="text-xs font-semibold text-gray-600">This class hasn&apos;t started yet — the roster fills in once attendance opens.</p>}
      {status === "missed" && <p className="text-xs font-semibold text-orange-700">This class was never started. Reschedule it to take attendance.</p>}
      <RosterTable roster={roster} canMark={canMark} onMark={onMark} />
    </div>
  );
}
