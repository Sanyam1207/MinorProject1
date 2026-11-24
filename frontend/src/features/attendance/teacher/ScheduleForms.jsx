// NEW CLASS / RESCHEDULE and AUTO-SCHEDULE dialogs (FRONTEND.md §13.1 SchedulePanel).
import { useState } from "react";
import { CalendarPlus, LoaderCircle, Wand2 } from "lucide-react";
import { autoScheduleSession, createSessionWithMeta, updateSessionWithMeta } from "../../../lib/api/attendance.js";
import Field from "../../../ui/Field.jsx";
import Modal from "../../../ui/Modal.jsx";
import { toastInfo, toastSuccess } from "../../../ui/toast.js";
import { DAY_OPTIONS } from "./courseForm.js";
import { conflictsOf, teacherError } from "./errors.js";
import { fromIstInputValue, istDateTime, minutesBetween, toIstInputValue } from "./ist.js";
import { ConflictList, CoursePicker } from "./parts.jsx";

const inputClass = "input-stark w-full text-base sm:text-xs";

function FormError({ error }) {
  if (!error) return null;
  const conflicts = conflictsOf(error);
  if (conflicts.length) return <ConflictList conflicts={conflicts} message={teacherError(error)} />;
  return (
    <p role="alert" className="border-2 border-black bg-red-50 p-2 text-xs font-bold text-red-800">
      {teacherError(error, "Couldn't save the class")}
    </p>
  );
}

/**
 * Create (no `session`) or reschedule (`session` given, scheduled only).
 * onSaved(session) after a successful save.
 */
export function SessionFormModal({ open, onClose, courses = [], session = null, defaultCourseId, defaultDate, onSaved }) {
  if (!open) return null;
  return (
    <SessionForm
      key={session?._id ?? "new"}
      onClose={onClose}
      courses={courses}
      session={session}
      defaultCourseId={defaultCourseId}
      defaultDate={defaultDate}
      onSaved={onSaved}
    />
  );
}

function SessionForm({ onClose, courses, session, defaultCourseId, defaultDate, onSaved }) {
  const editing = Boolean(session);
  const activeCourses = courses.filter((course) => course.status !== "archived");
  const [form, setForm] = useState(() => ({
    courseId: session?.course?._id ?? defaultCourseId ?? (activeCourses.length === 1 ? activeCourses[0]._id : ""),
    whenMode: "pick",
    startsAt: session ? toIstInputValue(session.startsAt) : defaultDate ? `${defaultDate}T10:00` : "",
    when: "",
    durationMinutes: String(session?.durationMinutes ?? minutesBetween(session?.startsAt, session?.endsAt) ?? 60),
    room: session?.room ?? "",
    topic: session?.topic ?? "",
    mode: session?.mode ?? "offline",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    const body = {};
    if (form.whenMode === "pick") {
      const iso = fromIstInputValue(form.startsAt);
      if (iso && (!editing || form.startsAt !== toIstInputValue(session.startsAt))) body.startsAt = iso;
      else if (!editing && !iso) {
        setError(new Error("Pick the date and time of the class."));
        return;
      }
    } else if (form.when.trim()) {
      body.when = form.when.trim();
    } else if (!editing) {
      setError(new Error('Type when the class is, e.g. "tomorrow 10am".'));
      return;
    }
    const duration = Number(form.durationMinutes);
    if (!Number.isInteger(duration) || duration < 15 || duration > 300) {
      setError(new Error("Duration must be 15–300 minutes."));
      return;
    }
    body.durationMinutes = duration;
    body.room = form.room.trim();
    body.topic = form.topic.trim();
    body.mode = form.mode;
    setBusy(true);
    try {
      if (editing) {
        const result = await updateSessionWithMeta(session._id, body);
        if (result.changed) toastSuccess("Class updated — students were notified of any time or room change");
        else toastInfo("Nothing to change");
        onSaved?.(result.session);
      } else {
        if (!form.courseId) throw new Error("Choose the course.");
        const result = await createSessionWithMeta({ courseId: form.courseId, ...body });
        toastSuccess(`Class scheduled for ${istDateTime(result.session?.startsAt)} — ${result.notified} student${result.notified === 1 ? "" : "s"} notified`);
        onSaved?.(result.session);
      }
      onClose();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      title={editing ? `Reschedule ${session.course?.code ?? "class"}` : "New class"}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="session-form" disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />}
            {editing ? "SAVE CHANGES" : "SCHEDULE & NOTIFY"}
          </button>
        </>
      }
    >
      <form id="session-form" onSubmit={submit} className="space-y-3">
        {!editing && (
          <CoursePicker courses={activeCourses} value={form.courseId} onChange={(courseId) => setForm((current) => ({ ...current, courseId: courseId ?? "" }))} required />
        )}
        <div>
          <div className="mb-1 flex items-center gap-1" role="radiogroup" aria-label="How to enter the time">
            {[
              ["pick", "Pick date & time"],
              ["text", "Type it"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.whenMode === value}
                onClick={() => setForm((current) => ({ ...current, whenMode: value }))}
                className={`px-2.5 py-1 text-[10px] font-black uppercase ${form.whenMode === value ? "bg-black text-white" : "bg-gray-100 hover:bg-gray-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {form.whenMode === "pick" ? (
            <Field label="Starts at (IST)" hint={editing ? "Leave as is to keep the time" : "India Standard Time"}>
              <input type="datetime-local" value={form.startsAt} onChange={set("startsAt")} className={inputClass} step={300} />
            </Field>
          ) : (
            <Field label="When" hint={editing ? 'e.g. "friday" keeps the time, "tomorrow 2pm" moves both' : 'e.g. "tomorrow 10am", "next monday 2:30pm"'}>
              <input type="text" value={form.when} onChange={set("when")} className={inputClass} placeholder="tomorrow 10am" maxLength={80} />
            </Field>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duration (min)">
            <input type="number" min={15} max={300} step={5} value={form.durationMinutes} onChange={set("durationMinutes")} className={inputClass} />
          </Field>
          <Field label="Mode">
            <select value={form.mode} onChange={set("mode")} className={inputClass}>
              <option value="offline">In class</option>
              <option value="online">Online</option>
            </select>
          </Field>
        </div>
        <Field label="Room" hint="Defaults to the course's room">
          <input type="text" value={form.room} onChange={set("room")} className={inputClass} maxLength={60} placeholder="LT-2" />
        </Field>
        <Field label="Topic">
          <input type="text" value={form.topic} onChange={set("topic")} className={inputClass} maxLength={200} placeholder="Normalization" />
        </Field>
        {!editing && <p className="text-[11px] font-semibold text-gray-600">Enrolled students get a notification as soon as the class is scheduled.</p>}
        <FormError error={error} />
      </form>
    </Modal>
  );
}

/** AUTO-SCHEDULE: the server picks the earliest free slot avoiding every clash. */
export function AutoScheduleModal({ open, onClose, courses = [], defaultCourseId, onSaved }) {
  if (!open) return null;
  return <AutoScheduleForm onClose={onClose} courses={courses} defaultCourseId={defaultCourseId} onSaved={onSaved} />;
}

function AutoScheduleForm({ onClose, courses, defaultCourseId, onSaved }) {
  const activeCourses = courses.filter((course) => course.status !== "archived");
  const [form, setForm] = useState(() => ({
    courseId: defaultCourseId ?? (activeCourses.length === 1 ? activeCourses[0]._id : ""),
    durationMinutes: "60",
    earliest: "",
    latest: "",
    preferredDays: [],
    preferredStart: "",
    preferredEnd: "",
    topic: "",
    room: "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const toggleDay = (day) =>
    setForm((current) => ({
      ...current,
      preferredDays: current.preferredDays.includes(day) ? current.preferredDays.filter((value) => value !== day) : [...current.preferredDays, day],
    }));

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!form.courseId) {
      setError(new Error("Choose the course."));
      return;
    }
    const body = { courseId: form.courseId, durationMinutes: Number(form.durationMinutes) || 60 };
    if (form.earliest) body.earliest = form.earliest;
    if (form.latest) body.latest = form.latest;
    if (form.preferredDays.length) body.preferredDays = [...form.preferredDays].sort((a, b) => a - b);
    if (form.preferredStart) body.preferredStart = form.preferredStart;
    if (form.preferredEnd) body.preferredEnd = form.preferredEnd;
    if (form.topic.trim()) body.topic = form.topic.trim();
    if (form.room.trim()) body.room = form.room.trim();
    setBusy(true);
    try {
      const scheduled = await autoScheduleSession(body);
      setResult(scheduled);
      toastSuccess(`Class scheduled for ${istDateTime(scheduled.session?.startsAt)} — ${scheduled.notified} notified`);
      onSaved?.(scheduled.session);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      title="Auto-schedule a class"
      onClose={busy ? undefined : onClose}
      footer={
        result ? (
          <button type="button" onClick={onClose} className="btn-primary min-h-11 px-3 text-xs sm:min-h-0">
            DONE
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
              CANCEL
            </button>
            <button type="submit" form="auto-form" disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
              {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />}
              FIND A FREE SLOT
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-2">
          <div className="border-2 border-black bg-green-100 p-3">
            <div className="text-xs font-black uppercase">Scheduled</div>
            <div className="text-base font-black">{istDateTime(result.session?.startsAt)}</div>
            <div className="text-xs font-semibold">
              {result.session?.course?.code} · {result.session?.durationMinutes ?? form.durationMinutes} min
              {result.session?.room ? ` · ${result.session.room}` : ""}
            </div>
          </div>
          {result.reason && <p className="text-xs font-medium text-gray-700">{result.reason}</p>}
          <p className="text-[11px] font-semibold text-gray-600">{result.notified} enrolled students were notified.</p>
        </div>
      ) : (
        <form id="auto-form" onSubmit={submit} className="space-y-3">
          <p className="text-[11px] font-semibold text-gray-600">
            Finds the earliest slot that clashes with none of your classes, this course&apos;s classes or other classes its students attend.
          </p>
          <CoursePicker courses={activeCourses} value={form.courseId} onChange={(courseId) => setForm((current) => ({ ...current, courseId: courseId ?? "" }))} required />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)">
              <input type="number" min={15} max={300} step={5} value={form.durationMinutes} onChange={set("durationMinutes")} className={inputClass} />
            </Field>
            <Field label="Room">
              <input type="text" value={form.room} onChange={set("room")} className={inputClass} maxLength={60} />
            </Field>
            <Field label="Earliest day" hint="Default: in 1 hour">
              <input type="date" value={form.earliest} onChange={set("earliest")} className={inputClass} />
            </Field>
            <Field label="Latest day" hint="Default: a week later">
              <input type="date" value={form.latest} onChange={set("latest")} className={inputClass} />
            </Field>
            <Field label="Between (IST)" hint="Default 09:00">
              <input type="time" value={form.preferredStart} onChange={set("preferredStart")} className={inputClass} />
            </Field>
            <Field label="And" hint="Default 17:00">
              <input type="time" value={form.preferredEnd} onChange={set("preferredEnd")} className={inputClass} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 block text-xs font-extrabold uppercase">Preferred days</legend>
            <div className="flex flex-wrap gap-1">
              {DAY_OPTIONS.map((day) => {
                const on = form.preferredDays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(day.value)}
                    className={`min-h-9 border-2 border-black px-2 text-[10px] font-black uppercase ${on ? "bg-black text-white" : "bg-white hover:bg-gray-100"}`}
                  >
                    {day.label.slice(0, 3)}
                  </button>
                );
              })}
            </div>
            <span className="mt-1 block text-[10px] font-semibold text-gray-500">None selected = college working days</span>
          </fieldset>
          <Field label="Topic">
            <input type="text" value={form.topic} onChange={set("topic")} className={inputClass} maxLength={200} />
          </Field>
          <FormError error={error} />
        </form>
      )}
    </Modal>
  );
}
