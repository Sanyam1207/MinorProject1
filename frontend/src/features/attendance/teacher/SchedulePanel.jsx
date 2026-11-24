import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarPlus,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Pencil,
  Play,
  Radio,
  Wand2,
} from "lucide-react";
import { ATTENDANCE_EVENTS, cancelSession, listCourses, listSessions } from "../../../lib/api/attendance.js";
import { useSocketEvent } from "../../../lib/realtime.js";
import ConfirmDialog from "../../../ui/ConfirmDialog.jsx";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import Panel from "../../../ui/Panel.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import Tabs from "../../../ui/Tabs.jsx";
import { toastError, toastSuccess } from "../../../ui/toast.js";
import { useAsync } from "../../../ui/useAsync.js";
import { useNow } from "../../../ui/useNow.js";
import { openPanel, usePanel } from "../../../workspace/index.js";
import { teacherError } from "./errors.js";
import { addDays, canStartNow, groupByIstDay, istDayHeading, istDayKey, istTime, sessionStatus, weekdayOfKey } from "./ist.js";
import { AutoScheduleModal, SessionFormModal } from "./ScheduleForms.jsx";
import { CoursePicker, SessionMeta, SourceBadge } from "./parts.jsx";
import { useStartSession } from "./startFlow.js";

const RANGES = [
  { id: "upcoming", label: "Upcoming" },
  { id: "past", label: "Past" },
];

/** teacher.schedule — day-grouped list (phones) or week grid (≥ lg), manual + auto scheduling. */
export default function SchedulePanel() {
  const { params, nonce, setParams } = usePanel("teacher.schedule");
  return <ScheduleView key={nonce} params={params} setParams={setParams} />;
}

function ScheduleView({ params, setParams }) {
  const today = istDayKey(useNow(60000));
  const [range, setRange] = useState("upcoming");
  const [dialog, setDialog] = useState(() => (params.create ? { type: "new" } : null));
  const [cancelling, setCancelling] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const { start, startingId } = useStartSession();
  const view = params.view === "week" ? "week" : "list";
  const anchor = params.date || today;

  const coursesState = useAsync(() => listCourses(), []);
  const courses = coursesState.data ?? [];

  const span = view === "week"
    ? weekWindow(anchor)
    : params.date
      ? { from: params.date, to: addDays(params.date, 13) }
      : range === "upcoming"
        ? { from: today, to: addDays(today, 30) }
        : { from: addDays(today, -30), to: today };

  const sessionsState = useAsync(
    () => listSessions({ from: span.from, to: span.to, courseId: params.courseId }),
    [span.from, span.to, params.courseId],
  );
  const reload = sessionsState.reload;
  useSocketEvent(ATTENDANCE_EVENTS.SESSION, () => reload());

  let sessions = sessionsState.data ?? [];
  if (view === "list" && !params.date && range === "past") sessions = [...sessions].reverse();

  const handleStart = async (session) => {
    const course = courses.find((item) => item._id === session.course?._id);
    try {
      const result = await start(session._id, { requireGeo: Boolean(course?.settings?.requireGeo) });
      toastSuccess(result.alreadyLive ? "Class is already live" : "Attendance is open");
      openPanel("teacher.live", { sessionId: session._id });
    } catch (error) {
      toastError(teacherError(error, "Couldn't start the class"));
    }
  };

  const confirmCancel = async (reason) => {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await cancelSession(cancelling._id, { reason });
      toastSuccess("Class cancelled — students were notified");
      setCancelling(null);
      reload();
    } catch (error) {
      toastError(teacherError(error, "Couldn't cancel the class"));
    } finally {
      setCancelBusy(false);
    }
  };

  const onSaved = (session) => {
    if (session?._id) setParams({ sessionId: session._id });
    reload();
  };

  const actions = {
    onStart: handleStart,
    onReschedule: (session) => setDialog({ type: "edit", session }),
    onCancel: (session) => setCancelling(session),
    startingId,
  };

  return (
    <Panel
      title="Class schedule"
      icon={CalendarClock}
      badge="IST"
      actions={
        <>
          <button type="button" onClick={() => setDialog({ type: "auto" })} className="btn-secondary min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0">
            <Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> AUTO-SCHEDULE
          </button>
          <button type="button" onClick={() => setDialog({ type: "new" })} className="btn-primary min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0">
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" /> NEW CLASS
          </button>
        </>
      }
    >
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <CoursePicker
          className="sm:w-72"
          courses={courses}
          value={params.courseId}
          allowAll
          onChange={(courseId) => setParams({ courseId })}
        />
        <div className="flex flex-wrap items-center gap-2">
          {view === "list" && !params.date && <Tabs tabs={RANGES} value={range} onChange={setRange} label="Range" className="w-auto" />}
          {params.date && view === "list" && (
            <button type="button" onClick={() => setParams({ date: undefined })} className="btn-secondary px-2 py-1 text-[10px]">
              FROM {istDayHeading(`${params.date}T12:00:00+05:30`).toUpperCase()} ✕
            </button>
          )}
          <div className="hidden items-center gap-1 lg:flex">
            <Tabs
              tabs={[
                { id: "list", label: "List" },
                { id: "week", label: "Week" },
              ]}
              value={view}
              onChange={(next) => setParams({ view: next })}
              label="View"
              className="w-auto"
            />
          </div>
        </div>
      </div>

      {view === "week" && (
        <div className="mb-2 hidden items-center justify-between lg:flex">
          <button type="button" onClick={() => setParams({ date: addDays(span.from, -7) })} className="btn-secondary px-2 py-1 text-[10px]">
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> PREV WEEK
          </button>
          <span className="text-xs font-black uppercase">
            Week of {istDayHeading(`${span.from}T12:00:00+05:30`)}
          </span>
          <button type="button" onClick={() => setParams({ date: addDays(span.from, 7) })} className="btn-secondary px-2 py-1 text-[10px]">
            NEXT WEEK <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {sessionsState.loading && !sessionsState.data ? (
        <LoadingState label="LOADING CLASSES…" />
      ) : sessionsState.error ? (
        <ErrorState error={sessionsState.error} onRetry={reload} />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No classes in this window"
          text={courses.length ? "Schedule one manually, let AUTO-SCHEDULE find a free slot, or add a weekly timetable to a course." : "Create a course first — then schedule its classes here."}
          action={
            courses.length ? (
              <button type="button" onClick={() => setDialog({ type: "new" })} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
                <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" /> NEW CLASS
              </button>
            ) : (
              <button type="button" onClick={() => openPanel("teacher.courses", { create: true })} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
                CREATE COURSE
              </button>
            )
          }
        />
      ) : (
        <>
          <div className={view === "week" ? "lg:hidden" : ""}>
            <DayList sessions={sessions} highlightId={params.sessionId} actions={actions} />
          </div>
          {view === "week" && (
            <div className="hidden lg:block">
              <WeekGrid from={span.from} sessions={sessions} highlightId={params.sessionId} onPick={(session) => setParams({ sessionId: session._id })} actions={actions} />
            </div>
          )}
        </>
      )}

      <SessionFormModal
        open={dialog?.type === "new" || dialog?.type === "edit"}
        session={dialog?.type === "edit" ? dialog.session : null}
        courses={courses}
        defaultCourseId={params.courseId}
        defaultDate={params.date}
        onClose={() => setDialog(null)}
        onSaved={onSaved}
      />
      <AutoScheduleModal open={dialog?.type === "auto"} courses={courses} defaultCourseId={params.courseId} onClose={() => setDialog(null)} onSaved={onSaved} />
      <ConfirmDialog
        open={Boolean(cancelling)}
        title={`Cancel ${cancelling?.course?.code ?? "class"}?`}
        body={cancelling ? `${istDayHeading(cancelling.startsAt)}, ${istTime(cancelling.startsAt)}. Enrolled students are notified with your reason.` : ""}
        confirmLabel="CANCEL CLASS"
        cancelLabel="KEEP IT"
        danger
        busy={cancelBusy}
        requireReason
        reasonLabel="Reason (sent to students)"
        onConfirm={confirmCancel}
        onCancel={() => setCancelling(null)}
      />
    </Panel>
  );
}

/** Monday-start week containing `dayKey`. */
function weekWindow(dayKey) {
  const weekday = weekdayOfKey(dayKey);
  const from = addDays(dayKey, -((weekday + 6) % 7));
  return { from, to: addDays(from, 6) };
}

function DayList({ sessions, highlightId, actions }) {
  const groups = groupByIstDay(sessions);
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.key}>
          <h4 className="sticky top-0 z-[1] mb-1.5 border-b-2 border-black bg-white py-1 text-xs font-black uppercase">{group.label}</h4>
          <ul className="space-y-2">
            {group.sessions.map((session) => (
              <SessionRow key={session._id} session={session} highlighted={session._id === highlightId} actions={actions} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SessionRow({ session, highlighted, actions }) {
  const now = useNow(30000);
  const ref = useRef(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  const status = sessionStatus(session, now);
  const startable = canStartNow(session, now);
  return (
    <li
      ref={ref}
      className={`border-2 border-black bg-white p-2.5 ${highlighted ? "shadow-[4px_4px_0_0_#000] ring-2 ring-yellow-300" : ""} ${status === "cancelled" ? "opacity-70" : ""}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs font-black">{session.course?.code}</span>
            <span className="truncate text-xs font-bold">{session.course?.name}</span>
            <StatusBadge kind="session" status={status} />
            <SourceBadge source={session.source} />
          </div>
          <SessionMeta session={session} />
          {status === "cancelled" && session.cancelReason && <p className="text-[10px] font-semibold text-red-700">Cancelled: {session.cancelReason}</p>}
          {(status === "ended" || status === "live") && (
            <p className="text-[10px] font-bold tabular-nums text-gray-600">
              {(session.stats?.present ?? 0) + (session.stats?.late ?? 0)}/{session.stats?.enrolled ?? 0} present
            </p>
          )}
        </div>
        <SessionActions session={session} status={status} startable={startable} actions={actions} />
      </div>
    </li>
  );
}

function SessionActions({ session, status, startable, actions, compact = false }) {
  const size = compact ? "px-1.5 py-0.5 text-[9px]" : "min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0";
  return (
    <div className="flex shrink-0 flex-wrap gap-1.5">
      {status === "live" && (
        <button type="button" onClick={() => openPanel("teacher.live", { sessionId: session._id })} className={`btn-primary ${size}`}>
          <Radio className="h-3.5 w-3.5" aria-hidden="true" /> OPEN LIVE
        </button>
      )}
      {status === "scheduled" && startable && (
        <button type="button" onClick={() => actions.onStart(session)} disabled={actions.startingId === session._id} className={`btn-primary ${size} disabled:opacity-60`}>
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {actions.startingId === session._id ? "STARTING…" : "START"}
        </button>
      )}
      {status === "ended" && (
        <button type="button" onClick={() => openPanel("teacher.report", { sessionId: session._id })} className={`btn-secondary ${size}`}>
          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> REPORT
        </button>
      )}
      {(status === "scheduled" || status === "missed") && (
        <button type="button" onClick={() => actions.onReschedule(session)} className={`btn-secondary ${size}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> RESCHEDULE
        </button>
      )}
      {(status === "scheduled" || status === "live" || status === "missed") && (
        <button type="button" onClick={() => actions.onCancel(session)} className={`btn-secondary ${size} text-red-700`}>
          <CalendarX2 className="h-3.5 w-3.5" aria-hidden="true" /> CANCEL
        </button>
      )}
    </div>
  );
}

function WeekGrid({ from, sessions, highlightId, onPick, actions }) {
  const now = useNow(30000);
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const byDay = new Map(days.map((key) => [key, []]));
  for (const session of sessions) byDay.get(istDayKey(session.startsAt))?.push(session);
  const highlighted = sessions.find((session) => session._id === highlightId);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-7 border-2 border-black">
        {days.map((key) => (
          <div key={key} className="min-h-40 border-r-2 border-black last:border-r-0">
            <div className={`border-b-2 border-black px-1.5 py-1 text-[10px] font-black uppercase ${key === istDayKey(now) ? "bg-black text-white" : "bg-gray-100"}`}>
              {istDayHeading(`${key}T12:00:00+05:30`)}
            </div>
            <div className="space-y-1 p-1">
              {byDay.get(key).map((session) => {
                const status = sessionStatus(session, now);
                return (
                  <button
                    key={session._id}
                    type="button"
                    onClick={() => onPick(session)}
                    className={`block w-full border-[1.5px] border-black p-1 text-left text-[10px] hover:bg-gray-50 ${session._id === highlightId ? "bg-yellow-100" : "bg-white"} ${status === "cancelled" ? "line-through opacity-60" : ""}`}
                  >
                    <span className="block font-black tabular-nums">{istTime(session.startsAt)}</span>
                    <span className="block truncate font-mono font-bold">{session.course?.code}</span>
                    <StatusBadge kind="session" status={status} className="mt-0.5 text-[8px]" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {highlighted && (
        <div className="border-2 border-black p-2.5">
          <div className="mb-1 text-[10px] font-black uppercase text-gray-500">Selected class</div>
          <ul>
            <SessionRow session={highlighted} highlighted={false} actions={actions} />
          </ul>
        </div>
      )}
    </div>
  );
}
