import { useState } from "react";
import { ArrowDown, ArrowUp, BellRing, LoaderCircle, Users } from "lucide-react";
import { getCourseReport, notifyDefaulters } from "../../../lib/api/attendance.js";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import Field from "../../../ui/Field.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import Modal from "../../../ui/Modal.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import { toastError, toastSuccess } from "../../../ui/toast.js";
import { useAsync } from "../../../ui/useAsync.js";
import { teacherError } from "./errors.js";
import { studentLabel, studentRoll } from "./liveState.js";
import { StatTile } from "./parts.jsx";

const COLUMNS = [
  { key: "name", label: "Student" },
  { key: "attended", label: "Attended" },
  { key: "late", label: "Late" },
  { key: "absent", label: "Absent" },
  { key: "excused", label: "Excused" },
  { key: "percent", label: "%" },
  { key: "needToReach", label: "Need" },
];

const sortValue = (row, key) => {
  if (key === "name") return (studentLabel(row.student) || "").toLowerCase();
  const value = row[key];
  return value === null || value === undefined ? Number.POSITIVE_INFINITY : Number(value);
};

/** Standing for a custom threshold (server rule: safe ≥ t+5, warning ≥ t, else critical). */
const standingFor = (percent, threshold) => {
  if (percent === null || percent === undefined) return "no-data";
  if (percent >= threshold + 5) return "safe";
  if (percent >= threshold) return "warning";
  return "critical";
};

/**
 * Per-student course report with a threshold slider highlighting defaulters.
 * `readOnly` (tpo/admin) hides NOTIFY DEFAULTERS.
 */
export default function CourseReportView({ courseId, threshold: thresholdParam, onThresholdChange, readOnly = false }) {
  const state = useAsync(() => getCourseReport(courseId), [courseId], { enabled: Boolean(courseId) });
  const report = state.data;
  const [sort, setSort] = useState({ key: "percent", dir: "asc" });
  const [localThreshold, setLocalThreshold] = useState(null);
  const [notifyOpen, setNotifyOpen] = useState(false);

  if (state.loading && !report) return <LoadingState label="LOADING REPORT…" />;
  if (state.error && !report) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!report) return null;

  const courseThreshold = report.course?.settings?.minAttendancePercent ?? report.threshold ?? 75;
  const threshold = localThreshold ?? (Number.isFinite(thresholdParam) ? thresholdParam : courseThreshold);
  const students = report.students;
  const defaulters = students.filter((row) => row.percent !== null && row.percent < threshold);
  const withData = students.filter((row) => row.percent !== null);
  const average = withData.length ? withData.reduce((sum, row) => sum + row.percent, 0) / withData.length : null;

  const rows = [...students].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return sort.dir === "asc" ? cmp : -cmp;
  });
  const toggleSort = (key) => setSort((current) => (current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const commitThreshold = (value) => {
    setLocalThreshold(value);
    onThresholdChange?.(value);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Classes held" value={report.held} />
        <StatTile label="Students" value={students.length} />
        <StatTile label="Average" value={average === null ? "—" : `${average.toFixed(1)}%`} />
        <StatTile label={`Below ${threshold}%`} value={defaulters.length} tone={defaulters.length ? "bg-red-200" : "bg-green-200"} />
      </div>

      <div className="flex flex-col gap-3 border-2 border-black p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="block flex-1">
          <span className="mb-1 flex items-center justify-between text-xs font-extrabold uppercase">
            <span>Defaulter threshold</span>
            <span className="tabular-nums">{threshold}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={threshold}
            onChange={(event) => setLocalThreshold(Number(event.target.value))}
            onPointerUp={(event) => commitThreshold(Number(event.currentTarget.value))}
            onKeyUp={(event) => commitThreshold(Number(event.currentTarget.value))}
            className="w-full accent-black"
            aria-label="Defaulter threshold percent"
          />
          <span className="text-[10px] font-semibold text-gray-500">
            Course minimum: {courseThreshold}%
            {threshold !== courseThreshold && (
              <button type="button" onClick={() => commitThreshold(courseThreshold)} className="ml-2 underline">
                reset
              </button>
            )}
          </span>
        </label>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setNotifyOpen(true)}
            disabled={!defaulters.length}
            className="btn-primary min-h-11 shrink-0 px-3 text-xs disabled:opacity-50 sm:min-h-0"
          >
            <BellRing className="h-3.5 w-3.5" aria-hidden="true" /> NOTIFY {defaulters.length} DEFAULTER{defaulters.length === 1 ? "" : "S"}
          </button>
        )}
      </div>

      {students.length === 0 ? (
        <EmptyState icon={Users} title="No students enrolled" text="Add students to this course to see their attendance." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse border-2 border-black text-left text-xs">
            <thead>
              <tr className="bg-black text-white uppercase">
                {COLUMNS.map((column) => (
                  <th key={column.key} className="border-2 border-black p-0">
                    <button type="button" onClick={() => toggleSort(column.key)} className="flex w-full items-center gap-1 p-2 text-left font-black uppercase">
                      {column.label}
                      {sort.key === column.key &&
                        (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />)}
                    </button>
                  </th>
                ))}
                <th className="border-2 border-black p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const defaulter = row.percent !== null && row.percent < threshold;
                return (
                  <tr key={row.student?._id} className={defaulter ? "bg-red-50" : ""}>
                    <td className="border-2 border-black p-2">
                      <div className="font-bold">{studentLabel(row.student)}</div>
                      <div className="font-mono text-[10px] text-gray-500">{studentRoll(row.student) || row.student?.email}</div>
                    </td>
                    <td className="border-2 border-black p-2 tabular-nums">
                      {row.attended}/{Math.max(0, (row.held ?? 0) - (row.excused ?? 0))}
                    </td>
                    <td className="border-2 border-black p-2 tabular-nums">{row.late}</td>
                    <td className="border-2 border-black p-2 tabular-nums">{row.absent}</td>
                    <td className="border-2 border-black p-2 tabular-nums">{row.excused}</td>
                    <td className="border-2 border-black p-2">
                      <div className="font-black tabular-nums">{row.percent === null ? "—" : `${row.percent}%`}</div>
                      {row.percent !== null && (
                        <div className="mt-0.5 h-1.5 w-16 border border-black bg-gray-100">
                          <div className={`h-full ${defaulter ? "bg-red-500" : "bg-black"}`} style={{ width: `${Math.min(100, row.percent)}%` }} />
                        </div>
                      )}
                    </td>
                    <td className="border-2 border-black p-2 text-[11px] tabular-nums">
                      {row.percent === null ? "—" : threshold === courseThreshold ? (row.needToReach ? `${row.needToReach} classes` : "OK") : defaulter ? "below" : "OK"}
                    </td>
                    <td className="border-2 border-black p-2">
                      <StatusBadge kind="standing" status={threshold === courseThreshold ? row.status : standingFor(row.percent, threshold)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] font-semibold text-gray-500">
            Percent = (present + late) ÷ (held − excused). “Need” = consecutive classes to attend to reach {courseThreshold}%.
          </p>
        </div>
      )}

      {notifyOpen && (
        <NotifyDialog
          courseId={courseId}
          threshold={threshold}
          count={defaulters.length}
          onClose={() => setNotifyOpen(false)}
        />
      )}
    </div>
  );
}

function NotifyDialog({ courseId, threshold, count, onClose }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const result = await notifyDefaulters(courseId, { threshold, message: message.trim() || undefined });
      const already = result.alreadyNotified ? ` (${result.alreadyNotified} already notified today)` : "";
      toastSuccess(`Notified ${result.notified} student${result.notified === 1 ? "" : "s"}${already}`);
      onClose();
    } catch (error) {
      toastError(teacherError(error, "Couldn't notify the students"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      size="sm"
      title="Notify defaulters"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="button" onClick={send} disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <BellRing className="h-3.5 w-3.5" aria-hidden="true" />}
            NOTIFY {count}
          </button>
        </>
      }
    >
      <p className="mb-3 text-xs font-medium">
        {count} student{count === 1 ? " is" : "s are"} below {threshold}%. Each gets an in-app notification and an email with their percentage and how many classes they need to attend.
      </p>
      <Field label="Message (optional)" hint="Added to the notice, max 500 characters">
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} maxLength={500} className="input-stark w-full text-base sm:text-xs" />
      </Field>
    </Modal>
  );
}
