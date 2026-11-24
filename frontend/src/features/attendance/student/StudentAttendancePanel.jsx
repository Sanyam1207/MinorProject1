import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, CalendarCheck, ChevronRight, KeyRound, ListChecks, ScanQrCode } from "lucide-react";
import { getMyHistory, getMySummary, joinCourse } from "../../../lib/api/attendance.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Panel,
  STATUS_COLORS,
  StatusBadge,
  Tabs,
  formatDate,
  formatPercent,
  formatTime,
  toastSuccess,
  useAsync,
} from "../../../ui/index.js";
import { openPanel, usePanel } from "../../../workspace/index.js";
import { invalidateAttendanceSummary } from "./summary.js";
import { normalizeHistory, normalizeSummary, standingAdvice } from "./view.js";

const JOIN_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const pct = (value) => formatPercent(value, value !== null && value % 1 ? 1 : 0);

function PercentBar({ percent, min, status }) {
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="relative mt-2 h-2.5 border border-black bg-gray-100" aria-hidden="true">
      <div className={`h-full ${STATUS_COLORS.standing[status] ?? "bg-gray-100"}`} style={{ width: `${width}%` }} />
      {Number.isFinite(min) && min > 0 && min < 100 && <span className="absolute -top-1 bottom-[-4px] w-0.5 bg-black" style={{ left: `${min}%` }} />}
    </div>
  );
}

function OverallCard({ overall, courseCount }) {
  return (
    <div className={`border-2 border-black p-4 shadow-[4px_4px_0_0_#000] ${STATUS_COLORS.standing[overall.status] ?? "bg-gray-100"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest">Overall attendance</div>
          <div className="mt-1 text-4xl font-black tabular-nums tracking-tight">{pct(overall.percent)}</div>
          <div className="mt-1 text-[11px] font-bold tabular-nums">
            {overall.attended}/{overall.held} classes attended · {courseCount} course{courseCount === 1 ? "" : "s"}
          </div>
        </div>
        <StatusBadge kind="standing" status={overall.status} className="bg-white">
          {overall.status === "no-data" ? "NO CLASSES YET" : overall.status.toUpperCase()}
        </StatusBadge>
      </div>
      <PercentBar percent={overall.percent} min={overall.threshold} status="no-data" />
      <div className="mt-1 text-[10px] font-black uppercase">Minimum {overall.threshold}%</div>
    </div>
  );
}

function CourseCard({ row, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card-stark group flex w-full flex-col gap-1 bg-white text-left transition-colors hover:bg-gray-50"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="badge-stark bg-black font-mono text-[10px] text-white">{row.code}</span>
            {row.section && <span className="badge-stark text-[10px]">SEC {row.section}</span>}
            {row.archived && <span className="badge-stark bg-gray-200 text-[10px]">ARCHIVED</span>}
          </div>
          <div className="mt-1 truncate text-sm font-black uppercase">{row.name}</div>
          {row.teacherName && <div className="truncate text-[11px] font-semibold text-gray-600">{row.teacherName}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-black tabular-nums">{pct(row.percent)}</div>
          <StatusBadge kind="standing" status={row.status}>
            {row.status === "no-data" ? "NO DATA" : row.status.toUpperCase()}
          </StatusBadge>
        </div>
      </div>
      <PercentBar percent={row.percent} min={row.min} status={row.status} />
      <div className="mt-1 flex w-full items-center justify-between gap-2">
        <span className="text-[11px] font-bold tabular-nums">
          {row.attended}/{row.held} attended · min {row.min}%
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
      <p className={`mt-1 border-l-4 pl-2 text-[11px] font-semibold ${row.status === "critical" ? "border-red-500" : "border-black"}`}>{standingAdvice(row)}</p>
    </button>
  );
}

function HistoryList({ courseId }) {
  const history = useAsync(() => getMyHistory({ courseId: courseId || undefined, limit: 50 }), [courseId ?? ""]);
  if (history.loading && !history.data) return <LoadingState label="LOADING HISTORY…" />;
  if (history.error) return <ErrorState error={history.error} title="COULDN'T LOAD HISTORY" onRetry={history.reload} />;
  const records = normalizeHistory(history.data);
  if (!records.length) {
    return <EmptyState icon={ListChecks} title="No attendance records yet" text="Classes appear here once your teacher starts taking attendance." />;
  }
  return (
    <ul className="divide-y-[1.5px] divide-black border-2 border-black bg-white">
      {records.map((record) => (
        <li key={record._id ?? `${record.session?._id}-${record.markedAt}`} className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {!courseId && record.course?.code && <span className="badge-stark font-mono text-[10px]">{record.course.code}</span>}
              <span className="text-xs font-black uppercase tabular-nums">{formatDate(record.session?.startsAt, { weekday: "short", day: "numeric", month: "short" })}</span>
              <span className="text-[11px] font-semibold tabular-nums text-gray-600">{formatTime(record.session?.startsAt)}</span>
            </div>
            <div className="truncate text-[11px] font-semibold text-gray-700">
              {record.session?.topic || record.course?.name || "Class"}
              {record.method === "manual" ? " · marked by teacher" : record.method === "auto" ? " · not scanned" : ""}
            </div>
          </div>
          <StatusBadge kind="attendance" status={record.status} className="shrink-0" />
        </li>
      ))}
    </ul>
  );
}

function CourseDetail({ row, onBack }) {
  const counts = [
    ["present", row.present],
    ["late", row.late],
    ["absent", row.absent],
    ["excused", row.excused],
  ];
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0 sm:py-1.5">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> ALL COURSES
      </button>
      <div className={`border-2 border-black p-4 shadow-[4px_4px_0_0_#000] ${STATUS_COLORS.standing[row.status] ?? "bg-gray-100"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="badge-stark bg-black font-mono text-[10px] text-white">{row.code}</span>
            <div className="mt-1 text-base font-black uppercase tracking-tight">{row.name}</div>
            {row.teacherName && <div className="text-[11px] font-semibold">{row.teacherName}</div>}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-4xl font-black tabular-nums">{pct(row.percent)}</div>
            <div className="text-[11px] font-bold tabular-nums">
              {row.attended}/{row.held} attended
            </div>
          </div>
        </div>
        <PercentBar percent={row.percent} min={row.min} status="no-data" />
        <p className="mt-2 text-xs font-black">{standingAdvice(row)}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {counts.map(([status, count]) => (
          <div key={status} className={`border-2 border-black p-2 text-center ${STATUS_COLORS.attendance[status]}`}>
            <div className="text-xl font-black tabular-nums">{count}</div>
            <div className="text-[10px] font-black uppercase">{status}</div>
          </div>
        ))}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-black uppercase">History</h4>
        <HistoryList courseId={row.id} />
      </div>
    </div>
  );
}

function JoinCourseModal({ open, onClose, onJoined }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const normalized = code.replace(/[\s-]+/g, "").toUpperCase();
  const valid = JOIN_CODE.test(normalized);

  const submit = (event) => {
    event.preventDefault();
    if (!valid || busy) {
      if (!valid) setError("Join codes are 6 letters/digits, e.g. K7Q2MX (no 0, 1, I or O).");
      return;
    }
    setBusy(true);
    setError(null);
    joinCourse(normalized)
      .then((course) => {
        toastSuccess(`Joined ${course?.code ? `${course.code} — ` : ""}${course?.name ?? "the course"}`);
        setCode("");
        onJoined(course);
      })
      .catch((failure) => {
        setError(
          failure?.code === "NOT_FOUND"
            ? "No course matches that code. Check it with your teacher."
            : failure?.message || "Couldn't join the course. Try again.",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title="JOIN A COURSE" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-[11px] font-semibold text-gray-700">Enter the 6-character join code your teacher shared.</p>
        <label className="block">
          <span className="mb-1 block text-[10px] font-black uppercase">Join code</span>
          <input
            className="input-stark w-full text-center font-mono text-2xl uppercase tracking-[0.4em] sm:text-xl"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase().slice(0, 8));
              setError(null);
            }}
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            placeholder="K7Q2MX"
            aria-invalid={Boolean(error)}
            autoFocus
          />
        </label>
        {error && (
          <p role="alert" className="border-2 border-black bg-red-100 p-2 text-[11px] font-bold">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="btn-primary min-h-11 w-full justify-center text-xs disabled:opacity-60">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> {busy ? "JOINING…" : "JOIN COURSE"}
        </button>
      </form>
    </Modal>
  );
}

/** `attendance.student {courseId?, tab}` — the student's own attendance (FRONTEND.md §13.2). */
export default function StudentAttendancePanel() {
  const { params, data, setParams, clearData } = usePanel("attendance.student");
  const [joinOpen, setJoinOpen] = useState(() => Boolean(data?.openJoin));
  const summaryRequest = useAsync(() => getMySummary(), []);
  const courseId = params.courseId ?? null;
  const tab = params.tab ?? "overview";

  // A "join a course" request from the scanner arrives as panel data; consume it once.
  useEffect(() => {
    if (data?.openJoin) clearData();
  }, [data, clearData]);

  const summary = summaryRequest.data ? normalizeSummary(summaryRequest.data) : null;
  const selected = courseId && summary ? summary.courses.find((row) => row.id === courseId) ?? null : null;

  const onJoined = (course) => {
    setJoinOpen(false);
    invalidateAttendanceSummary();
    summaryRequest.reload();
    if (course?._id) setParams({ courseId: String(course._id), tab: "overview" });
  };

  const actions = (
    <>
      <button type="button" onClick={() => setJoinOpen(true)} className="btn-secondary min-h-11 px-3 text-[11px] sm:min-h-0 sm:py-1">
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> JOIN
      </button>
      <button type="button" onClick={() => openPanel("attendance.scan")} className="btn-primary min-h-11 px-3 text-[11px] sm:min-h-0 sm:py-1">
        <ScanQrCode className="h-3.5 w-3.5" aria-hidden="true" /> SCAN QR
      </button>
    </>
  );

  let content;
  if (summaryRequest.loading && !summary) {
    content = <LoadingState label="LOADING ATTENDANCE…" />;
  } else if (summaryRequest.error && !summary) {
    content = <ErrorState error={summaryRequest.error} title="COULDN'T LOAD ATTENDANCE" onRetry={summaryRequest.reload} />;
  } else if (courseId && selected) {
    content = <CourseDetail row={selected} onBack={() => setParams({ tab }, { replace: true })} />;
  } else if (courseId && !selected && summaryRequest.loading) {
    content = <LoadingState label="LOADING COURSE…" />;
  } else if (courseId && !selected) {
    content = (
      <EmptyState
        icon={BookOpen}
        title="Course not found"
        text="You're not enrolled in this course, or it was removed."
        action={
          <button type="button" onClick={() => setParams({ tab }, { replace: true })} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0 sm:py-1.5">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> ALL COURSES
          </button>
        }
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <Tabs
          label="Attendance views"
          tabs={[
            { id: "overview", label: "Courses", count: summary?.courses.length ?? 0 },
            { id: "history", label: "History" },
          ]}
          value={tab}
          onChange={(next) => setParams({ tab: next })}
        />
        {tab === "history" ? (
          <HistoryList courseId={null} />
        ) : summary && summary.courses.length ? (
          <>
            <OverallCard overall={summary.overall} courseCount={summary.courses.length} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {summary.courses.map((row) => (
                <CourseCard key={row.id} row={row} onOpen={() => setParams({ courseId: row.id })} />
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            icon={CalendarCheck}
            title="You're not in any course yet"
            text="Ask your teacher for the 6-character join code, or wait for them to add you."
            action={
              <button type="button" onClick={() => setJoinOpen(true)} className="btn-primary min-h-11 px-4 text-xs">
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> JOIN A COURSE
              </button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <Panel title="My attendance" icon={CalendarCheck} actions={actions}>
      {content}
      <JoinCourseModal open={joinOpen} onClose={() => setJoinOpen(false)} onJoined={onJoined} />
    </Panel>
  );
}
