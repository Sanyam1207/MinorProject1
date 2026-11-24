// Small presentational pieces shared by the teacher panels.
import { AlertTriangle, MapPin, Monitor } from "lucide-react";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import { istDateTime, istRange, istTime } from "./ist.js";

export function CoursePicker({ courses = [], value, onChange, label = "Course", allowAll = false, allLabel = "All courses", className = "", required = false }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-extrabold uppercase">{label}</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="input-stark w-full text-base sm:text-xs"
        required={required}
      >
        {(allowAll || !value) && <option value="">{allowAll ? allLabel : "Choose a course…"}</option>}
        {courses.map((course) => (
          <option key={course._id} value={course._id}>
            {course.code} · {course.name}
            {course.section ? ` (${course.section})` : ""}
            {course.status === "archived" ? " — archived" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 409 SCHEDULE_CONFLICT details. */
export function ConflictList({ conflicts = [], message }) {
  if (!conflicts.length) return null;
  return (
    <div role="alert" className="border-2 border-black bg-red-50 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-black uppercase">
        <AlertTriangle className="h-4 w-4 text-red-700" aria-hidden="true" /> Time clash
      </div>
      {message && <p className="mb-2 text-[11px] font-semibold text-gray-700">{message}</p>}
      <ul className="space-y-1">
        {conflicts.map((conflict) => (
          <li key={conflict.sessionId ?? `${conflict.startsAt}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono font-bold">{conflict.course?.code ?? "Class"}</span>
            <span className="font-medium">{conflict.course?.name ?? ""}</span>
            <span className="tabular-nums text-gray-700">
              {istDateTime(conflict.startsAt)} – {istTime(conflict.endsAt)}
            </span>
            {conflict.status && <StatusBadge kind="session" status={conflict.status} />}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] font-semibold text-gray-600">Pick another time, or use AUTO-SCHEDULE to find a free slot.</p>
    </div>
  );
}

export function StatTile({ label, value, tone = "bg-white", sub }) {
  return (
    <div className={`border-2 border-black p-2 ${tone}`}>
      <div className="text-xl font-black tabular-nums leading-tight">{value ?? "—"}</div>
      <div className="text-[10px] font-black uppercase">{label}</div>
      {sub && <div className="text-[10px] font-semibold text-gray-600">{sub}</div>}
    </div>
  );
}

export function SessionStats({ stats, className = "" }) {
  const s = stats || {};
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-5 ${className}`}>
      <StatTile label="Present" value={s.present ?? 0} tone="bg-green-200" />
      <StatTile label="Late" value={s.late ?? 0} tone="bg-yellow-200" />
      <StatTile label="Absent" value={s.absent ?? 0} tone="bg-red-200" />
      <StatTile label="Excused" value={s.excused ?? 0} tone="bg-blue-100" />
      <StatTile label="Enrolled" value={s.enrolled ?? 0} />
    </div>
  );
}

/** One-line description of a session: time, room, mode, topic. */
export function SessionMeta({ session }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold text-gray-700">
      <span className="tabular-nums">{istRange(session.startsAt, session.endsAt)}</span>
      {session.room && (
        <span className="inline-flex items-center gap-0.5">
          <MapPin className="h-3 w-3" aria-hidden="true" /> {session.room}
        </span>
      )}
      {session.mode === "online" && (
        <span className="inline-flex items-center gap-0.5">
          <Monitor className="h-3 w-3" aria-hidden="true" /> Online
        </span>
      )}
      {session.topic && <span className="truncate italic">“{session.topic}”</span>}
    </span>
  );
}

/** Square toggle (§15.4 recipe). */
export function Toggle({ checked, onChange, label, hint, disabled = false }) {
  return (
    <label className={`flex items-start justify-between gap-3 border-2 border-black bg-white p-2.5 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <span>
        <span className="block text-xs font-extrabold uppercase">{label}</span>
        {hint && <span className="block text-[10px] font-semibold text-gray-500">{hint}</span>}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" className={`relative h-6 w-12 shrink-0 border-2 border-black ${checked ? "bg-black" : "bg-gray-100"}`}>
        <span className={`absolute top-0.5 h-4 w-4 border-2 border-black bg-white transition-all ${checked ? "left-6" : "left-0.5"}`} />
      </span>
    </label>
  );
}

export function SourceBadge({ source }) {
  if (!source || source === "manual") return null;
  const label = { timetable: "TIMETABLE", auto: "AUTO", ai: "COPILOT" }[source] ?? String(source).toUpperCase();
  return <span className="badge-stark bg-purple-100 text-[9px]">{label}</span>;
}
