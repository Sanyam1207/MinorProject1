import { lazy, Suspense } from "react";
import { useSelector } from "react-redux";
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  CalendarDays,
  FileText,
  MonitorSmartphone,
  Play,
  Presentation,
  Radio,
} from "lucide-react";
import { ATTENDANCE_EVENTS, listSessions } from "../lib/api/attendance.js";
import { useSocketEvent } from "../lib/realtime.js";
import ErrorBoundary from "../ui/ErrorBoundary.jsx";
import ErrorState from "../ui/ErrorState.jsx";
import LoadingState from "../ui/LoadingState.jsx";
import StatusBadge from "../ui/StatusBadge.jsx";
import { toastError, toastSuccess } from "../ui/toast.js";
import { useAsync } from "../ui/useAsync.js";
import { useNow } from "../ui/useNow.js";
import BackBar from "../workspace/BackBar.jsx";
import ToolTile from "../workspace/ToolTile.jsx";
import { openPanel, panelTitle } from "../workspace/index.js";
import { teacherError } from "../features/attendance/teacher/errors.js";
import { canStartNow, istDayHeading, istDayKey, sessionStatus } from "../features/attendance/teacher/ist.js";
import { SessionMeta } from "../features/attendance/teacher/parts.jsx";
import { useStartSession } from "../features/attendance/teacher/startFlow.js";

const CoursesPanel = lazy(() => import("../features/attendance/teacher/CoursesPanel.jsx"));
const SchedulePanel = lazy(() => import("../features/attendance/teacher/SchedulePanel.jsx"));
const LiveSessionPanel = lazy(() => import("../features/attendance/teacher/LiveSessionPanel.jsx"));
const SessionReportPanel = lazy(() => import("../features/attendance/teacher/SessionReportPanel.jsx"));
const CourseAnalyticsPanel = lazy(() => import("../features/attendance/teacher/CourseAnalyticsPanel.jsx"));

const FEATURES = {
  courses: CoursesPanel,
  schedule: SchedulePanel,
  live: LiveSessionPanel,
  report: SessionReportPanel,
  analytics: CourseAnalyticsPanel,
};

/** Teacher workspace (FRONTEND.md §12.3): home (header, TODAY strip, tiles) or the active panel. */
export default function TeacherMode({ user }) {
  const activeFeature = useSelector((state) => state.appContext.activeFeature);
  const activePanel = useSelector((state) => state.appContext.activePanel);
  const Feature = activeFeature ? FEATURES[activeFeature] : null;

  if (!Feature) return <TeacherHome user={user} />;

  return (
    <div className="space-y-4 pb-4">
      <BackBar label="TEACHER HOME" title={panelTitle(activePanel)} onBack={() => openPanel("teacher.home")} />
      <ErrorBoundary resetKey={activeFeature}>
        <Suspense fallback={<LoadingState label="LOADING PANEL…" />}>
          <Feature />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function TeacherHome({ user }) {
  const subtitle = [user?.designation, user?.department].filter(Boolean).join(" · ");
  return (
    <div className="space-y-4 pb-4">
      <section className="card-stark flex flex-col gap-3 bg-white shadow-bold-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-black p-3 text-white">
            <Presentation className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-black uppercase tracking-tight">Welcome, {user?.name || "Professor"}</h2>
            <p className="truncate text-[11px] font-semibold text-gray-600">{subtitle || "Faculty"}</p>
            {user?.email && <p className="truncate font-mono text-[10px] text-gray-500">{user.email}</p>}
          </div>
        </div>
        <span className="badge-stark self-start bg-yellow-100 text-[10px] sm:self-center">TIMES IN IST</span>
      </section>

      <TodayStrip />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <ToolTile icon={BookOpen} title="My courses" description="Create courses, weekly timetable, join codes and rosters." badge="COURSES" onClick={() => openPanel("teacher.courses")} />
        <ToolTile icon={CalendarClock} title="Class schedule" description="Schedule classes manually or let auto-schedule find a free slot." badge="SCHEDULE" onClick={() => openPanel("teacher.schedule")} />
        <ToolTile icon={Radio} title="Live attendance" description="Start a class and show the rotating QR from your phone." badge="QR" badgeClass="bg-black text-white" onClick={() => openPanel("teacher.live")} />
        <ToolTile icon={FileText} title="Session reports" description="Roster of every class, manual corrections and CSV export." badge="REPORTS" onClick={() => openPanel("teacher.report")} />
        <ToolTile icon={BarChart3} title="Course analytics" description="Attendance per student, defaulters and notices." badge="DEFAULTERS" badgeClass="bg-red-100" onClick={() => openPanel("teacher.analytics")} />
      </div>
    </div>
  );
}

function TodayStrip() {
  const now = useNow(30000);
  const today = istDayKey(now);
  const state = useAsync(() => listSessions({ from: today, to: today }), [today]);
  const reload = state.reload;
  useSocketEvent(ATTENDANCE_EVENTS.SESSION, () => reload());
  const { start, startingId } = useStartSession();
  const sessions = (state.data ?? []).filter((session) => session.status !== "cancelled");

  const handleStart = async (session) => {
    try {
      const result = await start(session._id);
      toastSuccess(result.alreadyLive ? "Class is already live" : "Attendance is open — students were notified");
      openPanel("teacher.live", { sessionId: session._id });
    } catch (error) {
      toastError(teacherError(error, "Couldn't start the class"));
    }
  };

  const present = (sessionId) => window.open(`/present/${encodeURIComponent(sessionId)}`, "_blank", "noopener");

  return (
    <section className="card-stark bg-white">
      <div className="mb-3 flex items-center justify-between gap-2 border-b-2 border-black pb-2">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5" aria-hidden="true" />
          <h3 className="text-sm font-black uppercase">Today · {istDayHeading(now)}</h3>
        </div>
        <button type="button" onClick={() => openPanel("teacher.schedule", { create: true })} className="btn-secondary px-2 py-1 text-[10px]">
          + NEW CLASS
        </button>
      </div>
      {state.loading && !state.data ? (
        <LoadingState label="LOADING TODAY…" />
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={reload} />
      ) : sessions.length === 0 ? (
        <p className="text-xs font-semibold text-gray-600">No classes today. Use CLASS SCHEDULE or ask the copilot, e.g. “schedule DBMS tomorrow 10am”.</p>
      ) : (
        <ul className="scrollbar-hide -mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
          {sessions.map((session) => {
            const status = sessionStatus(session, now);
            const attended = (session.stats?.present ?? 0) + (session.stats?.late ?? 0);
            return (
              <li key={session._id} className="flex w-64 shrink-0 snap-start flex-col gap-1.5 border-2 border-black p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-black">{session.course?.code}</span>
                  <StatusBadge kind="session" status={status} />
                </div>
                <span className="truncate text-xs font-bold">{session.course?.name}</span>
                <SessionMeta session={session} />
                {(status === "live" || status === "ended") && (
                  <span className="text-[10px] font-black tabular-nums">
                    {attended}/{session.stats?.enrolled ?? 0} PRESENT
                  </span>
                )}
                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  {status === "scheduled" && canStartNow(session, now) && (
                    <button type="button" onClick={() => handleStart(session)} disabled={startingId === session._id} className="btn-primary min-h-11 px-2 py-1 text-[10px] disabled:opacity-60 sm:min-h-0">
                      <Play className="h-3 w-3" aria-hidden="true" /> {startingId === session._id ? "STARTING…" : "START"}
                    </button>
                  )}
                  {status === "live" && (
                    <>
                      <button type="button" onClick={() => present(session._id)} className="btn-primary min-h-11 px-2 py-1 text-[10px] sm:min-h-0">
                        <MonitorSmartphone className="h-3 w-3" aria-hidden="true" /> PRESENT
                      </button>
                      <button type="button" onClick={() => openPanel("teacher.live", { sessionId: session._id })} className="btn-secondary min-h-11 px-2 py-1 text-[10px] sm:min-h-0">
                        <Radio className="h-3 w-3" aria-hidden="true" /> LIVE
                      </button>
                    </>
                  )}
                  {(status === "ended" || status === "live") && (
                    <button type="button" onClick={() => openPanel("teacher.report", { sessionId: session._id })} className="btn-secondary min-h-11 px-2 py-1 text-[10px] sm:min-h-0">
                      <FileText className="h-3 w-3" aria-hidden="true" /> REPORT
                    </button>
                  )}
                  {((status === "scheduled" && !canStartNow(session, now)) || status === "missed") && (
                    <button type="button" onClick={() => openPanel("teacher.schedule", { sessionId: session._id })} className="btn-secondary min-h-11 px-2 py-1 text-[10px] sm:min-h-0">
                      VIEW
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
