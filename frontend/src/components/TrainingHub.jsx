import { useEffect, useState } from "react";
import { Award, BookOpen, CalendarDays, LoaderCircle, MapPin, UserRound, Users } from "lucide-react";
import { invalidateOpportunitySummary } from "../features/opportunities/summary.js";
import { listMyTraining, listTrainingPrograms, registerForTraining, unregisterFromTraining } from "../lib/api/placements.js";
import { useSocketEvent } from "../lib/realtime.js";
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, Panel, StatusBadge, Tabs, toastError, toastSuccess, useAsync, useNow } from "../ui/index.js";
import { formatDate, formatRelative } from "../ui/format.js";
import { usePanel } from "../workspace/index.js";

const PROGRAM_STATUS_COLOR = { upcoming: "scheduled", ongoing: "live", completed: "ended", cancelled: "cancelled" };
const COMPLETION_COLORS = { enrolled: "bg-blue-100", "in-progress": "bg-yellow-100", completed: "bg-green-200", dropped: "bg-gray-200" };
const humanize = (value) => String(value ?? "").replace(/[-_]+/g, " ").trim();

function Schedule({ sessions }) {
  if (!sessions.length) {
    return <p className="text-[11px] font-semibold text-gray-500">Schedule to be announced.</p>;
  }
  return (
    <ul className="space-y-1">
      {sessions.slice(0, 6).map((session, index) => (
        <li key={session._id ?? `${session.date}-${index}`} className="flex flex-wrap items-center gap-x-2 border-l-4 border-black bg-gray-50 px-2 py-1 text-[11px] font-semibold">
          <span className="font-black tabular-nums">{formatDate(session.date, { weekday: "short", day: "numeric", month: "short" })}</span>
          {session.time && <span className="tabular-nums">{session.time}</span>}
          {session.topic && <span className="text-gray-700">· {session.topic}</span>}
          {session.venue && (
            <span className="inline-flex items-center gap-0.5 text-gray-600">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {session.venue}
            </span>
          )}
        </li>
      ))}
      {sessions.length > 6 && <li className="text-[10px] font-bold text-gray-500">+{sessions.length - 6} more sessions</li>}
    </ul>
  );
}

function ProgramCard({ program, highlighted, busy, onRegister, onUnregister, enrollment = null }) {
  const now = useNow(60000);
  const deadlineMs = program.registrationDeadline ? new Date(program.registrationDeadline).getTime() : null;
  const deadlinePassed = deadlineMs !== null && deadlineMs <= now;
  const full = program.capacity !== null && (program.seatsLeft ?? program.capacity - program.enrolledCount) <= 0;
  const registered = enrollment ? true : program.isRegistered;
  const canRegister = !registered && program.status === "upcoming" && !full && !deadlinePassed;
  const canUnregister = registered && program.status === "upcoming";
  const scheduleLength = program.schedule.length;
  const attended = Array.isArray(enrollment?.attendance) ? enrollment.attendance.length : null;
  const certificate = enrollment?.certificateUrl && /^https?:\/\//i.test(enrollment.certificateUrl) ? enrollment.certificateUrl : null;

  let blockedLabel = null;
  if (!registered && !canRegister) {
    if (program.status !== "upcoming") blockedLabel = program.status === "ongoing" ? "ALREADY STARTED" : humanize(program.status).toUpperCase();
    else if (full) blockedLabel = "FULL";
    else if (deadlinePassed) blockedLabel = "REGISTRATION CLOSED";
  }

  return (
    <article
      id={`program-${program._id}`}
      className={`card-stark flex min-w-0 flex-col gap-3 bg-white ${highlighted ? "outline outline-4 outline-yellow-300" : ""}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-extrabold uppercase text-gray-600">
            {humanize(program.type)}
            {program.deliveryMode ? ` · ${humanize(program.deliveryMode)}` : ""}
          </div>
          <h4 className="break-words text-sm font-black uppercase leading-tight">{program.title}</h4>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {registered && <span className="badge-stark bg-green-200 text-[10px]">REGISTERED</span>}
          <StatusBadge kind="session" status={PROGRAM_STATUS_COLOR[program.status] ?? program.status}>
            {humanize(program.status).toUpperCase() || "UPCOMING"}
          </StatusBadge>
        </div>
      </header>

      {program.description && <p className="line-clamp-3 text-[11px] font-medium text-gray-700">{program.description}</p>}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-gray-700">
        {program.instructor && (
          <span className="inline-flex items-center gap-1">
            <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
            {program.instructor}
          </span>
        )}
        {program.capacity !== null && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {program.enrolledCount}/{program.capacity} seats
          </span>
        )}
        {program.registrationDeadline && (
          <span className={`inline-flex items-center gap-1 ${deadlinePassed ? "text-red-700" : ""}`}>
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            Register by {formatDate(program.registrationDeadline)} ({formatRelative(program.registrationDeadline, now)})
          </span>
        )}
      </div>

      <Schedule sessions={program.schedule} />

      {enrollment && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <span className={`badge-stark text-[10px] ${COMPLETION_COLORS[enrollment.completionStatus] ?? "bg-gray-100"}`}>
            {humanize(enrollment.completionStatus).toUpperCase()}
          </span>
          {attended !== null && scheduleLength > 0 && (
            <span className="tabular-nums">
              Attendance {attended}/{scheduleLength}
            </span>
          )}
        </div>
      )}

      {program.cancelReason && program.status === "cancelled" && (
        <p className="border-l-4 border-red-400 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-900">{program.cancelReason}</p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t-[1.5px] border-black pt-3">
        {canRegister && (
          <button type="button" onClick={() => onRegister(program)} disabled={busy} className="btn-primary min-h-11 px-2.5 py-1.5 text-[11px] disabled:opacity-50 sm:min-h-0">
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />}
            ENROLL
          </button>
        )}
        {blockedLabel && (
          <button type="button" disabled className="btn-primary min-h-11 cursor-not-allowed px-2.5 py-1.5 text-[11px] opacity-40 sm:min-h-0">
            {blockedLabel}
          </button>
        )}
        {canUnregister && (
          <button type="button" onClick={() => onUnregister(program)} disabled={busy} className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] text-red-700 sm:min-h-0">
            CANCEL REGISTRATION
          </button>
        )}
        {certificate && (
          <a href={certificate} target="_blank" rel="noopener noreferrer" className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0">
            <Award className="h-3.5 w-3.5" aria-hidden="true" />
            CERTIFICATE
          </a>
        )}
      </div>
    </article>
  );
}

/** TrainingHub — StudentMode `training` (usePanel("training") {tab: discover|mine, programId}). */
export default function TrainingHub() {
  const { params, setParams } = usePanel("training");
  const tab = params.tab === "mine" ? "mine" : "discover";
  const programs = useAsync(() => listTrainingPrograms(), []);
  const mine = useAsync(() => listMyTraining(), []);
  const reloadAll = () => {
    programs.reload();
    mine.reload();
  };
  useSocketEvent("placement:training", reloadAll);

  const [busyId, setBusyId] = useState(null);
  const [unregistering, setUnregistering] = useState(null);
  const highlightId = params.programId ?? null;

  const current = tab === "mine" ? mine : programs;
  const hasHighlight =
    Boolean(highlightId) &&
    (tab === "mine"
      ? (mine.data ?? []).some((entry) => entry.program?._id === highlightId)
      : (programs.data ?? []).some((program) => program._id === highlightId));
  useEffect(() => {
    if (!hasHighlight) return;
    document.getElementById(`program-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasHighlight, highlightId, tab]);

  const register = async (program) => {
    setBusyId(program._id);
    try {
      await registerForTraining(program._id);
      invalidateOpportunitySummary();
      toastSuccess(`Registered for ${program.title}`);
      reloadAll();
    } catch (error) {
      toastError(error, "Could not register for this program");
    } finally {
      setBusyId(null);
    }
  };

  const unregister = async () => {
    if (!unregistering) return;
    setBusyId(unregistering._id);
    try {
      await unregisterFromTraining(unregistering._id);
      invalidateOpportunitySummary();
      toastSuccess("Registration cancelled");
      setUnregistering(null);
      reloadAll();
    } catch (error) {
      toastError(error, "Could not cancel the registration");
    } finally {
      setBusyId(null);
    }
  };

  const enrollments = (mine.data ?? []).filter((entry) => entry.program);
  const tabs = [
    { id: "discover", label: "DISCOVER", count: programs.data ? programs.data.length : undefined },
    { id: "mine", label: "MY PROGRAMS", count: mine.data ? enrollments.length : undefined },
  ];

  let body;
  if (current.error && !current.data) {
    body = <ErrorState error={current.error} title="COULD NOT LOAD TRAINING" onRetry={current.reload} />;
  } else if (!current.data) {
    body = <LoadingState label="LOADING PROGRAMS…" />;
  } else if (tab === "discover") {
    body = programs.data.length ? (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {programs.data.map((program) => (
          <ProgramCard
            key={program._id}
            program={program}
            highlighted={program._id === highlightId}
            busy={busyId === program._id}
            onRegister={register}
            onUnregister={setUnregistering}
          />
        ))}
      </div>
    ) : (
      <EmptyState icon={BookOpen} title="No programs open right now" text="Aptitude, technical and soft-skills programs from your placement office appear here." />
    );
  } else {
    body = enrollments.length ? (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {enrollments.map((entry) => (
          <ProgramCard
            key={entry._id}
            program={entry.program}
            enrollment={entry}
            highlighted={entry.program._id === highlightId}
            busy={busyId === entry.program._id}
            onRegister={register}
            onUnregister={setUnregistering}
          />
        ))}
      </div>
    ) : (
      <EmptyState
        icon={BookOpen}
        title="You have not enrolled yet"
        text="Pick a program under DISCOVER to start."
        action={
          <button type="button" onClick={() => setParams({ tab: "discover" })} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            DISCOVER PROGRAMS
          </button>
        }
      />
    );
  }

  return (
    <Panel title="Training programs" icon={BookOpen}>
      <Tabs label="Training" tabs={tabs} value={tab} onChange={(id) => setParams({ tab: id })} className="mb-4" />
      {body}
      <ConfirmDialog
        open={Boolean(unregistering)}
        title="CANCEL REGISTRATION?"
        body={unregistering ? `You will lose your seat in ${unregistering.title}. You can register again while seats are left.` : ""}
        confirmLabel="CANCEL REGISTRATION"
        cancelLabel="KEEP MY SEAT"
        danger
        busy={Boolean(busyId)}
        onConfirm={unregister}
        onCancel={() => setUnregistering(null)}
      />
    </Panel>
  );
}
