import { useState } from "react";
import {
  ArrowLeft,
  CircleStop,
  Copy,
  ExternalLink,
  FileText,
  MapPin,
  Play,
  Radio,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import { endSession, listSessions, markRecord } from "../../../lib/api/attendance.js";
import ConfirmDialog from "../../../ui/ConfirmDialog.jsx";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import Panel from "../../../ui/Panel.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import { toastError, toastSuccess } from "../../../ui/toast.js";
import { useAsync } from "../../../ui/useAsync.js";
import { useNow } from "../../../ui/useNow.js";
import { openPanel, usePanel } from "../../../workspace/index.js";
import { teacherError } from "./errors.js";
import { addDays, canStartNow, istDateTime, istDayKey, istTime, sessionStatus, START_EARLY_MINUTES } from "./ist.js";
import { attendedCount } from "./liveState.js";
import { SessionMeta, SessionStats } from "./parts.jsx";
import QrDisplay from "./QrDisplay.jsx";
import RosterTable from "./RosterTable.jsx";
import { useStartSession } from "./startFlow.js";
import { useLiveSession } from "./useLiveSession.js";

/** teacher.live — start a class, show the rotating QR, watch scans, mark manually, end. */
export default function LiveSessionPanel() {
  const { params, nonce, setParams } = usePanel("teacher.live");
  return (
    <Panel
      title="Live attendance"
      icon={Radio}
      actions={
        params.sessionId ? (
          <button type="button" onClick={() => setParams({ sessionId: undefined })} className="btn-secondary min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> TODAY&apos;S CLASSES
          </button>
        ) : null
      }
    >
      {params.sessionId ? (
        <LiveView key={`${params.sessionId}:${nonce}`} sessionId={params.sessionId} />
      ) : (
        <TodayPicker key={nonce} onPick={(sessionId) => setParams({ sessionId })} />
      )}
    </Panel>
  );
}

const presenterUrl = (sessionId) =>
  `${typeof window !== "undefined" ? window.location.origin : ""}/present/${encodeURIComponent(sessionId)}`;

function TodayPicker({ onPick }) {
  const now = useNow(30000);
  const today = istDayKey(now);
  const state = useAsync(() => listSessions({ from: addDays(today, -1), to: today }), [today]);
  const { start, startingId } = useStartSession();

  if (state.loading && !state.data) return <LoadingState label="LOADING TODAY'S CLASSES…" />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  const sessions = (state.data ?? []).filter((session) => session.status === "live" || (istDayKey(session.startsAt) === today && session.status !== "cancelled"));
  const live = sessions.filter((session) => session.status === "live");
  const rest = sessions.filter((session) => session.status !== "live");

  const handleStart = async (session) => {
    try {
      const result = await start(session._id);
      toastSuccess(result.alreadyLive ? "Class is already live" : "Attendance is open");
      onPick(session._id);
    } catch (error) {
      toastError(teacherError(error, "Couldn't start the class"));
    }
  };

  if (!sessions.length) {
    return (
      <EmptyState
        icon={Radio}
        title="No classes today"
        text="Schedule a class to take attendance with the rotating QR code."
        action={
          <button type="button" onClick={() => openPanel("teacher.schedule", { create: true })} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
            SCHEDULE A CLASS
          </button>
        }
      />
    );
  }

  const row = (session) => {
    const status = sessionStatus(session, now);
    return (
      <li key={session._id} className="flex flex-col gap-2 border-2 border-black p-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs font-black">{session.course?.code}</span>
            <span className="truncate text-xs font-bold">{session.course?.name}</span>
            <StatusBadge kind="session" status={status} />
          </div>
          <SessionMeta session={session} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {status === "live" && (
            <button type="button" onClick={() => onPick(session._id)} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" /> OPEN
            </button>
          )}
          {status === "scheduled" && (
            <button
              type="button"
              onClick={() => (canStartNow(session, now) ? handleStart(session) : onPick(session._id))}
              disabled={startingId === session._id}
              className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" /> {startingId === session._id ? "STARTING…" : canStartNow(session, now) ? "START" : "OPEN"}
            </button>
          )}
          {status === "ended" && (
            <button type="button" onClick={() => openPanel("teacher.report", { sessionId: session._id })} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" /> REPORT
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {live.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-black uppercase">Live now</h4>
          <ul className="space-y-2">{live.map(row)}</ul>
        </section>
      )}
      {rest.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-black uppercase">Today</h4>
          <ul className="space-y-2">{rest.map(row)}</ul>
        </section>
      )}
    </div>
  );
}

function LiveView({ sessionId }) {
  const now = useNow(15000);
  const live = useLiveSession(sessionId);
  const { session, course, stats, qr, deadline, connected } = live;
  const { start, startingId } = useStartSession();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);

  if (live.loading) return <LoadingState label="LOADING CLASS…" />;
  if (live.error && !session) return <ErrorState error={live.error} onRetry={live.reload} title="COULDN'T LOAD THIS CLASS" />;
  if (!session) return null;

  const status = sessionStatus(session, now);
  const requireGeo = Boolean(course?.settings?.requireGeo);
  const enrolled = stats.enrolled || course?.studentCount || 0;
  const present = attendedCount(stats);

  const handleStart = async () => {
    try {
      const result = await start(sessionId, { requireGeo });
      live.applyStart(result);
      toastSuccess(result.alreadyLive ? "Class is already live" : "Attendance is open — students were notified");
    } catch (error) {
      toastError(teacherError(error, "Couldn't start the class"));
    }
  };

  const handleEnd = async () => {
    setEnding(true);
    try {
      const result = await endSession(sessionId);
      live.applySession(result.session, result.stats);
      setConfirmEnd(false);
      toastSuccess("Class ended — absentees were marked automatically");
      openPanel("teacher.report", { sessionId });
    } catch (error) {
      toastError(teacherError(error, "Couldn't end the class"));
    } finally {
      setEnding(false);
    }
  };

  const onMark = async (studentId, value, note) => {
    try {
      const result = await markRecord(sessionId, { studentId, status: value, note });
      live.applyMark(result);
      toastSuccess(`Marked ${value}`);
    } catch (error) {
      toastError(teacherError(error, "Couldn't update attendance"));
      throw error;
    }
  };

  const copyPresenterLink = async () => {
    try {
      await navigator.clipboard.writeText(presenterUrl(sessionId));
      toastSuccess("Presenter link copied — open it on your phone");
    } catch {
      toastError("Couldn't copy. Open /present/" + sessionId + " on your phone.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1 border-2 border-black p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm font-black">{course?.code ?? session.course?.code}</span>
          <span className="text-sm font-bold">{course?.name ?? session.course?.name}</span>
          <StatusBadge kind="session" status={status} />
          {requireGeo && (
            <span className="badge-stark bg-blue-100 text-[9px]">
              <MapPin className="h-3 w-3" aria-hidden="true" /> LOCATION CHECK
            </span>
          )}
          {status === "live" && (
            <span className={`badge-stark text-[9px] ${connected ? "bg-green-200" : "bg-red-200"}`}>
              {connected ? <Wifi className="h-3 w-3" aria-hidden="true" /> : <WifiOff className="h-3 w-3" aria-hidden="true" />}
              {connected ? "REALTIME" : "RECONNECTING"}
            </span>
          )}
        </div>
        <div className="text-xs font-black uppercase">{istDateTime(session.startsAt)}</div>
        <SessionMeta session={session} />
      </div>

      {status === "live" && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
          <div className="mx-auto w-full max-w-[18rem]">
            <QrDisplay qr={qr} deadline={deadline} resolution={600} />
          </div>
          <div className="space-y-3">
            <div className="border-2 border-black bg-black p-3 text-white">
              <div className="text-4xl font-black tabular-nums leading-none" aria-live="polite">
                {present}
                <span className="text-gray-400">/{enrolled}</span>
              </div>
              <div className="text-[10px] font-black uppercase">Present (incl. late)</div>
            </div>
            <SessionStats stats={stats} />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => window.open(`/present/${encodeURIComponent(sessionId)}`, "_blank", "noopener")}
                className="btn-primary min-h-11 px-3 text-xs sm:min-h-0"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> PRESENT FULL SCREEN
              </button>
              <button type="button" onClick={copyPresenterLink} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
                <Copy className="h-3.5 w-3.5" aria-hidden="true" /> COPY PHONE LINK
              </button>
              <button type="button" onClick={() => setConfirmEnd(true)} className="btn-primary min-h-11 border-red-700 bg-red-600 px-3 text-xs hover:bg-red-700 sm:min-h-0">
                <CircleStop className="h-3.5 w-3.5" aria-hidden="true" /> END SESSION
              </button>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] font-semibold text-gray-600">
              <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Show the code from your phone: open the presenter link there (signed in as you). The code changes after every scan and every {qr?.rotationSeconds ?? course?.settings?.qrRotationSeconds ?? 15} s, so a shared photo stops working.
            </p>
          </div>
        </div>
      )}

      {status === "scheduled" && (
        <div className="border-2 border-black bg-blue-50 p-4 text-center">
          <p className="text-xs font-black uppercase">Starts at {istTime(session.startsAt)}</p>
          <p className="mt-1 text-[11px] font-semibold text-gray-700">
            {canStartNow(session, now)
              ? "Start attendance to show the rotating QR. Enrolled students get a notification to scan."
              : `You can start this class from ${START_EARLY_MINUTES} minutes before it begins.`}
            {requireGeo && " Your location is captured when you start, so students' scans can be checked against the classroom."}
          </p>
          <button
            type="button"
            onClick={handleStart}
            disabled={startingId === sessionId || !canStartNow(session, now)}
            className="btn-primary mt-3 min-h-11 px-4 text-sm disabled:opacity-50"
          >
            <Play className="h-4 w-4" aria-hidden="true" /> {startingId === sessionId ? "STARTING…" : "START ATTENDANCE"}
          </button>
        </div>
      )}

      {status === "missed" && (
        <div className="border-2 border-black bg-orange-50 p-4 text-center text-xs font-semibold">
          This class&apos;s time is over and it was never started. Reschedule it from the schedule to take attendance.
          <div className="mt-2">
            <button type="button" onClick={() => openPanel("teacher.schedule", { sessionId })} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
              OPEN SCHEDULE
            </button>
          </div>
        </div>
      )}

      {(status === "ended" || status === "cancelled") && (
        <div className="border-2 border-black bg-gray-50 p-4 text-center">
          <p className="text-xs font-black uppercase">{status === "ended" ? "This class has ended" : "This class was cancelled"}</p>
          {status === "ended" && (
            <button type="button" onClick={() => openPanel("teacher.report", { sessionId })} className="btn-primary mt-3 min-h-11 px-3 text-xs sm:min-h-0">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" /> OPEN REPORT
            </button>
          )}
        </div>
      )}

      {(status === "live" || status === "ended") && (
        <section>
          <h4 className="mb-2 border-b-2 border-black pb-1 text-xs font-black uppercase">Roster — newest scans first</h4>
          <RosterTable roster={live.roster} canMark onMark={onMark} newestFirst />
        </section>
      )}

      <ConfirmDialog
        open={confirmEnd}
        title="End this class?"
        body={`Attendance closes now and ${Math.max(0, enrolled - present - (stats.absent || 0) - (stats.excused || 0))} students without a mark will be recorded absent. You can still correct marks in the report.`}
        confirmLabel="END SESSION"
        danger
        busy={ending}
        onConfirm={handleEnd}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}
