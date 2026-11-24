import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CircleStop,
  FileText,
  Maximize,
  Minimize,
  Play,
  Sun,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { endSession } from "../../../lib/api/attendance.js";
import { useSession } from "../../auth/useSession.js";
import ConfirmDialog from "../../../ui/ConfirmDialog.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import { toastError, toastSuccess } from "../../../ui/toast.js";
import { openPanel } from "../../../workspace/index.js";
import QrDisplay from "./QrDisplay.jsx";
import { teacherError } from "./errors.js";
import { istDateTime, istRange, istTime } from "./ist.js";
import { attendedCount, studentLabel, studentRoll } from "./liveState.js";
import { useStartSession } from "./startFlow.js";
import { useLiveSession } from "./useLiveSession.js";
import { useWakeLock } from "./useWakeLock.js";

/** Full-screen, phone-first QR presenter (route /present/:sessionId, FRONTEND.md §13.1). */
export default function PresenterPage() {
  const { sessionId } = useParams();
  return <Presenter key={sessionId} sessionId={sessionId} />;
}

const fullscreenAvailable = () => typeof document !== "undefined" && Boolean(document.documentElement?.requestFullscreen);

function Presenter({ sessionId }) {
  const navigate = useNavigate();
  const { role } = useSession();
  const live = useLiveSession(sessionId);
  const { session, course, stats, qr, deadline, connected, isLive } = live;
  const wakeLock = useWakeLock(isLive);
  const { start, startingId } = useStartSession();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isTeacher = role === "teacher";

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      toastError("Full screen isn't available in this browser.");
    }
  };

  const handleStart = async () => {
    try {
      const result = await start(sessionId, { requireGeo: Boolean(course?.settings?.requireGeo) });
      live.applyStart(result);
      toastSuccess(result.alreadyLive ? "Class is already live" : "Attendance is open — students can scan now");
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
    } catch (error) {
      toastError(teacherError(error, "Couldn't end the class"));
    } finally {
      setEnding(false);
    }
  };

  const openReport = () => {
    openPanel("teacher.report", { sessionId });
    navigate("/");
  };

  if (live.loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-white p-4">
        <LoadingState label="OPENING PRESENTER…" />
      </div>
    );
  }

  if (live.error && !session) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-white p-4">
        <div className="w-full max-w-md">
          <ErrorState error={teacherError(live.error, "Couldn't open this class")} title="CAN'T PRESENT THIS CLASS" onRetry={live.reload} />
        </div>
        <Link to="/" className="btn-secondary min-h-11 px-3 py-1.5 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> BACK TO APP
        </Link>
      </div>
    );
  }

  const enrolled = stats.enrolled || course?.studentCount || 0;
  const present = attendedCount(stats);
  const title = [course?.code ?? session?.course?.code, course?.name ?? session?.course?.name].filter(Boolean).join(" · ");

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-white text-black">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-black px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isLive ? (
              <span className="badge-stark animate-pulse bg-black text-[10px] text-white">● LIVE</span>
            ) : (
              <StatusBadge kind="session" status={session?.status ?? "scheduled"} />
            )}
            <h1 className="truncate text-sm font-black uppercase tracking-tight sm:text-base">{title || "Class"}</h1>
          </div>
          <p className="truncate text-[11px] font-semibold text-gray-600">
            {session?.topic ? `${session.topic} · ` : ""}
            {session ? istRange(session.startsAt, session.endsAt) : ""}
            {session?.room ? ` · ${session.room}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <div className="text-2xl font-black leading-none tabular-nums sm:text-4xl" aria-live="polite">
            {present}
            <span className="text-gray-400">/{enrolled}</span>
          </div>
          <div className="text-[10px] font-black uppercase">Present</div>
        </div>
      </header>

      {isLive ? (
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-3 landscape:flex-row landscape:gap-6">
          <div className="w-[min(92vw,calc(100dvh-21rem))] min-w-40 landscape:w-[min(55vw,calc(100dvh-8rem))]">
            <QrDisplay qr={qr} deadline={deadline} resolution={900} />
          </div>
          <aside className="flex w-full max-w-md min-w-0 flex-col gap-2 landscape:max-w-sm landscape:flex-1">
            <ConnectionLine connected={connected} wakeLock={wakeLock} />
            <RecentScans marks={live.marks} />
            <div className="flex flex-wrap gap-2 pb-[env(safe-area-inset-bottom)]">
              {isTeacher && (
                <button type="button" onClick={() => setConfirmEnd(true)} className="btn-primary min-h-11 flex-1 justify-center border-red-700 bg-red-600 px-3 text-xs hover:bg-red-700">
                  <CircleStop className="h-4 w-4" aria-hidden="true" /> END SESSION
                </button>
              )}
              {fullscreenAvailable() && (
                <button type="button" onClick={toggleFullscreen} className="btn-secondary min-h-11 justify-center px-3 text-xs" aria-label={isFullscreen ? "Exit full screen" : "Full screen"}>
                  {isFullscreen ? <Minimize className="h-4 w-4" aria-hidden="true" /> : <Maximize className="h-4 w-4" aria-hidden="true" />}
                </button>
              )}
              <Link to="/" className="btn-secondary min-h-11 justify-center px-3 text-xs">
                EXIT
              </Link>
            </div>
          </aside>
        </main>
      ) : (
        <NotLive
          session={session}
          stats={stats}
          present={present}
          enrolled={enrolled}
          canStart={isTeacher && session?.status === "scheduled"}
          starting={startingId === sessionId}
          onStart={handleStart}
          onReport={openReport}
          joinError={live.joinState.status === "error" ? live.joinState.error : null}
        />
      )}

      <ConfirmDialog
        open={confirmEnd}
        title="END THIS CLASS?"
        body={`Attendance closes now. ${Math.max(0, enrolled - present - (stats.absent || 0) - (stats.excused || 0))} students without a scan will be marked absent.`}
        confirmLabel="END SESSION"
        danger
        busy={ending}
        onConfirm={handleEnd}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}

function ConnectionLine({ connected, wakeLock }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] font-black uppercase">
      <span className={`badge-stark ${connected ? "bg-green-200" : "bg-red-200"}`}>
        {connected ? <Wifi className="h-3 w-3" aria-hidden="true" /> : <WifiOff className="h-3 w-3" aria-hidden="true" />}
        {connected ? "Connected" : "Reconnecting…"}
      </span>
      {wakeLock.supported && (
        <span className={`badge-stark ${wakeLock.active ? "bg-yellow-100" : "bg-gray-100"}`}>
          <Sun className="h-3 w-3" aria-hidden="true" />
          {wakeLock.active ? "Screen stays on" : "Screen may sleep"}
        </span>
      )}
      <span className="text-gray-500">New code after every scan</span>
    </div>
  );
}

function RecentScans({ marks }) {
  const recent = marks.slice(0, 5);
  return (
    <div className="border-2 border-black">
      <div className="flex items-center gap-1.5 border-b-2 border-black bg-black px-2 py-1 text-[10px] font-black uppercase text-white">
        <Users className="h-3 w-3" aria-hidden="true" /> Recent scans
      </div>
      {recent.length === 0 ? (
        <p className="px-2 py-2 text-[11px] font-semibold text-gray-500">Waiting for the first scan…</p>
      ) : (
        <ul className="max-h-[4.6rem] divide-y divide-gray-200 overflow-hidden landscape:max-h-none">
          {recent.map((mark) => (
            <li key={mark._id ?? mark.student?._id} className="animate-item-up flex items-center justify-between gap-2 px-2 py-1 text-xs">
              <span className="min-w-0 truncate font-bold">
                {studentLabel(mark.student)}
                {studentRoll(mark.student) && <span className="ml-1 font-mono text-[10px] text-gray-500">{studentRoll(mark.student)}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {mark.method === "manual" && <span className="badge-stark text-[9px]">MANUAL</span>}
                <StatusBadge kind="attendance" status={mark.status} />
                <span className="text-[10px] font-semibold tabular-nums text-gray-500">{istTime(mark.markedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotLive({ session, stats, present, enrolled, canStart, starting, onStart, onReport, joinError }) {
  const ended = session?.status === "ended";
  const cancelled = session?.status === "cancelled";
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
      <section className="card-stark w-full max-w-md bg-white p-5 text-center shadow-[4px_4px_0_0_#000]">
        <h2 className="text-lg font-black uppercase tracking-tight">
          {ended ? "Class ended" : cancelled ? "Class cancelled" : "This session is not live"}
        </h2>
        {session && <p className="mt-1 text-xs font-semibold text-gray-600">{istDateTime(session.startsAt)}</p>}
        {cancelled && session?.cancelReason && <p className="mt-1 text-xs font-medium">Reason: {session.cancelReason}</p>}
        {ended && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Count label="Present" value={stats.present} tone="bg-green-200" />
            <Count label="Late" value={stats.late} tone="bg-yellow-200" />
            <Count label="Absent" value={stats.absent} tone="bg-red-200" />
            <Count label="Excused" value={stats.excused} tone="bg-blue-100" />
            <p className="col-span-2 text-xs font-black uppercase sm:col-span-4">
              {present}/{enrolled} attended
            </p>
          </div>
        )}
        {!ended && !cancelled && (
          <p className="mt-2 text-xs font-medium text-gray-700">
            {canStart
              ? "Start the class to show the rotating QR code. Enrolled students get a notification to scan."
              : joinError?.message || "Ask the class's teacher to start attendance."}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {canStart && (
            <button type="button" onClick={onStart} disabled={starting} className="btn-primary min-h-11 justify-center text-sm disabled:opacity-60">
              <Play className="h-4 w-4" aria-hidden="true" /> {starting ? "STARTING…" : "START ATTENDANCE"}
            </button>
          )}
          {ended && (
            <button type="button" onClick={onReport} className="btn-primary min-h-11 justify-center text-sm">
              <FileText className="h-4 w-4" aria-hidden="true" /> OPEN REPORT
            </button>
          )}
          <Link to="/" className="btn-secondary min-h-11 justify-center text-sm">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> BACK TO APP
          </Link>
        </div>
      </section>
    </main>
  );
}

function Count({ label, value, tone }) {
  return (
    <div className={`border-2 border-black p-2 ${tone}`}>
      <div className="text-2xl font-black tabular-nums">{value ?? 0}</div>
      <div className="text-[10px] font-black uppercase">{label}</div>
    </div>
  );
}
