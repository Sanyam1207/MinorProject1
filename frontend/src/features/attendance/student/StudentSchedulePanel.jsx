import { CalendarClock, MapPin, Radio, RotateCcw, ScanQrCode, User } from "lucide-react";
import { ATTENDANCE_EVENTS, getMySchedule } from "../../../lib/api/attendance.js";
import { useSocketEvent } from "../../../lib/realtime.js";
import { EmptyState, ErrorState, LoadingState, Panel, StatusBadge, Tabs, formatRelative, formatTime, toastInfo, useAsync, useNow } from "../../../ui/index.js";
import { openPanel, usePanel } from "../../../workspace/index.js";
import { invalidateAttendanceSummary } from "./summary.js";
import { dayLabel, groupByDay, normalizeSessions, sessionStatus } from "./view.js";

const RANGES = [
  { id: 1, label: "Today" },
  { id: 7, label: "7 days" },
  { id: 14, label: "14 days" },
];

function SessionRow({ session, now }) {
  const status = sessionStatus(session);
  const live = status === "live";
  const cancelled = status === "cancelled";
  const startsAt = new Date(session.startsAt).getTime();
  const soon = status === "scheduled" && startsAt > now && startsAt - now <= 30 * 60_000;
  const course = session.course ?? {};

  return (
    <li
      className={`flex flex-col gap-2 border-2 border-black p-3 sm:flex-row sm:items-center sm:justify-between ${
        live ? "bg-yellow-100 shadow-[4px_4px_0_0_#000]" : cancelled ? "bg-gray-50" : "bg-white"
      }`}
    >
      <div className="flex min-w-0 gap-3">
        <div className={`w-16 shrink-0 text-xs font-black tabular-nums ${cancelled ? "text-gray-400 line-through" : ""}`}>
          <div>{formatTime(session.startsAt)}</div>
          <div className="text-[10px] font-bold text-gray-500">{formatTime(session.endsAt)}</div>
        </div>
        <div className={`min-w-0 ${cancelled ? "text-gray-500" : ""}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {course.code && <span className="badge-stark bg-black font-mono text-[10px] text-white">{course.code}</span>}
            <StatusBadge kind="session" status={status}>
              {live ? (
                <>
                  <Radio className="h-3 w-3 animate-pulse" aria-hidden="true" /> LIVE NOW
                </>
              ) : undefined}
            </StatusBadge>
            {session.myRecord && <StatusBadge kind="attendance" status={session.myRecord} />}
            {soon && <span className="badge-stark bg-yellow-200 text-[10px]">STARTS {formatRelative(session.startsAt, now).toUpperCase()}</span>}
          </div>
          <div className={`mt-1 truncate text-sm font-black uppercase ${cancelled ? "line-through" : ""}`}>{course.name || "Class"}</div>
          {session.topic && <div className="truncate text-[11px] font-semibold text-gray-700">{session.topic}</div>}
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-semibold text-gray-600">
            {(session.room || course.room) && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" aria-hidden="true" /> {session.room || course.room}
              </span>
            )}
            {session.teacher?.name && (
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" aria-hidden="true" /> {session.teacher.name}
              </span>
            )}
            {session.mode === "online" && <span>Online</span>}
          </div>
          {cancelled && <p className="mt-1 text-[11px] font-bold text-red-700">Cancelled{session.cancelReason ? `: ${session.cancelReason}` : ""}</p>}
        </div>
      </div>
      {live && !session.myRecord && (
        <button type="button" onClick={() => openPanel("attendance.scan")} className="btn-primary min-h-11 shrink-0 justify-center px-4 text-xs">
          <ScanQrCode className="h-4 w-4" aria-hidden="true" /> SCAN NOW
        </button>
      )}
    </li>
  );
}

/** `schedule {days, date}` — upcoming classes; live ones highlighted with SCAN NOW. */
export default function StudentSchedulePanel() {
  const { params, setParams } = usePanel("schedule");
  const days = params.days ?? 7;
  const schedule = useAsync(() => getMySchedule({ days }), [days]);
  const now = useNow(30000);
  const { reload } = schedule;

  // A class went live / ended / was cancelled or rescheduled.
  useSocketEvent(ATTENDANCE_EVENTS?.SESSION ?? "attendance:session", (payload) => {
    reload();
    invalidateAttendanceSummary();
    const session = payload?.session;
    if (session?.status === "live") toastInfo(`${session.course?.code ?? "A class"} is live — scan the QR to mark attendance`);
  });

  const sessions = normalizeSessions(schedule.data);
  const groups = groupByDay(sessions);
  const liveCount = sessions.filter((session) => sessionStatus(session) === "live").length;
  const liveToScan = sessions.filter((session) => sessionStatus(session) === "live" && !session.myRecord).length;

  let content;
  if (schedule.loading && !schedule.data) content = <LoadingState label="LOADING SCHEDULE…" />;
  else if (schedule.error && !schedule.data) content = <ErrorState error={schedule.error} title="COULDN'T LOAD YOUR SCHEDULE" onRetry={reload} />;
  else if (!groups.length) {
    content = (
      <EmptyState
        icon={CalendarClock}
        title="No upcoming classes"
        text={`Nothing scheduled in the next ${days === 1 ? "day" : `${days} days`}. New classes from your courses appear here automatically.`}
      />
    );
  } else {
    content = (
      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.key}>
            <h4 className="mb-2 border-b-[1.5px] border-black pb-1 text-xs font-black uppercase tracking-wide">{dayLabel(group.date, now)}</h4>
            <ul className="space-y-2">
              {group.sessions.map((session) => (
                <SessionRow key={session._id} session={session} now={now} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <Panel
      title="Class schedule"
      icon={CalendarClock}
      badge={liveCount ? `${liveCount} LIVE` : undefined}
      actions={
        <button type="button" onClick={reload} className="btn-secondary min-h-11 px-3 text-[11px] sm:min-h-0 sm:py-1" aria-label="Refresh schedule">
          <RotateCcw className={`h-3.5 w-3.5 ${schedule.loading ? "animate-spin" : ""}`} aria-hidden="true" /> REFRESH
        </button>
      }
    >
      <div className="space-y-4">
        <Tabs label="Schedule range" tabs={RANGES} value={days} onChange={(next) => setParams({ days: next })} />
        {liveToScan > 0 && (
          <button
            type="button"
            onClick={() => openPanel("attendance.scan")}
            className="flex min-h-11 w-full items-center justify-between gap-2 border-2 border-black bg-black px-4 py-3 text-left text-white"
          >
            <span className="flex items-center gap-2 text-xs font-black uppercase">
              <Radio className="h-4 w-4 animate-pulse" aria-hidden="true" />
              {liveToScan === 1 ? "A class is live — attendance is open" : `${liveToScan} live classes need your scan`}
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-black uppercase">
              <ScanQrCode className="h-4 w-4" aria-hidden="true" /> SCAN NOW
            </span>
          </button>
        )}
        {content}
      </div>
    </Panel>
  );
}
