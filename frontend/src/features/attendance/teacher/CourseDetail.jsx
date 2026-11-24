import { useState } from "react";
import {
  Archive,
  BarChart3,
  CalendarPlus,
  Copy,
  LoaderCircle,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Wand2,
} from "lucide-react";
import {
  addStudents,
  archiveCourse,
  autoEnroll,
  generateSessions,
  getCourse,
  regenerateJoinCode,
  removeStudent,
  updateCourseWithMeta,
} from "../../../lib/api/attendance.js";
import ConfirmDialog from "../../../ui/ConfirmDialog.jsx";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import Field from "../../../ui/Field.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import Tabs from "../../../ui/Tabs.jsx";
import { toastError, toastInfo, toastSuccess } from "../../../ui/toast.js";
import { useAsync } from "../../../ui/useAsync.js";
import { useNow } from "../../../ui/useNow.js";
import { openPanel } from "../../../workspace/index.js";
import { courseToForm, formToPayload, parseEmailList, timetableToPayload, validateCourseForm } from "./courseForm.js";
import { DetailsFields, SettingsFields, TimetableEditor } from "./CourseFormFields.jsx";
import { teacherError } from "./errors.js";
import { canStartNow, istDayHeading, sessionStatus, WEEKDAYS } from "./ist.js";
import { studentLabel, studentRoll } from "./liveState.js";
import { SessionMeta, SourceBadge, StatTile } from "./parts.jsx";
import { useStartSession } from "./startFlow.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "students", label: "Students" },
  { id: "timetable", label: "Timetable" },
  { id: "settings", label: "Settings" },
];

/** Course detail with tabs overview / students / timetable / settings. */
export default function CourseDetail({ courseId, tab = "overview", onTab, onChanged, onArchived }) {
  const state = useAsync(() => getCourse(courseId), [courseId]);
  const detail = state.data;

  if (state.loading && !detail) return <LoadingState label="LOADING COURSE…" />;
  if (state.error && !detail) return <ErrorState error={state.error} onRetry={state.reload} title="COULDN'T LOAD THIS COURSE" />;
  if (!detail?.course) return null;

  const { course } = detail;
  const archived = course.status === "archived";
  const refresh = () => {
    state.reload();
    onChanged?.();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1 border-2 border-black p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base font-black">{course.code}</span>
          <span className="text-sm font-bold">{course.name}</span>
          {archived && <span className="badge-stark bg-gray-200 text-[10px]">ARCHIVED</span>}
        </div>
        <div className="text-[11px] font-semibold text-gray-600">
          {[course.branch, course.semester ? `Sem ${course.semester}` : null, course.section ? `Section ${course.section}` : null, course.passingYear ? `Batch ${course.passingYear}` : null, course.academicYear, course.room]
            .filter(Boolean)
            .join(" · ") || "No branch / section set"}
        </div>
      </div>
      {archived && (
        <p className="border-2 border-black bg-gray-100 p-2 text-xs font-semibold">This course is archived: its reports stay available, but it can&apos;t be edited or scheduled.</p>
      )}
      <Tabs tabs={TABS.map((item) => (item.id === "students" ? { ...item, count: detail.students.length } : item))} value={tab} onChange={onTab} label="Course sections" />
      {tab === "overview" && <Overview detail={detail} archived={archived} onRefresh={refresh} onArchived={onArchived} />}
      {tab === "students" && <Students detail={detail} archived={archived} onRefresh={refresh} />}
      {tab === "timetable" && <TimetableTab key={course.updatedAt ?? "t"} course={course} archived={archived} onRefresh={refresh} />}
      {tab === "settings" && <SettingsTab key={course.updatedAt ?? "s"} course={course} archived={archived} onRefresh={refresh} />}
    </div>
  );
}

function Overview({ detail, archived, onRefresh, onArchived }) {
  const { course, upcoming, students } = detail;
  const now = useNow(30000);
  const [joinCode, setJoinCode] = useState(course.joinCode);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const { start, startingId } = useStartSession();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinCode);
      toastSuccess("Join code copied");
    } catch {
      toastInfo(`Join code: ${joinCode}`);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      if (confirm === "regenerate") {
        const result = await regenerateJoinCode(course._id);
        setJoinCode(result.joinCode);
        toastSuccess("New join code ready — the old one no longer works");
      } else if (confirm === "archive") {
        await archiveCourse(course._id);
        toastSuccess(`${course.code} archived — its future classes were called off`);
        onArchived?.();
      }
      setConfirm(null);
      onRefresh();
    } catch (error) {
      toastError(teacherError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async (session) => {
    try {
      await start(session._id, { requireGeo: Boolean(course.settings?.requireGeo) });
      openPanel("teacher.live", { sessionId: session._id });
    } catch (error) {
      toastError(teacherError(error, "Couldn't start the class"));
    }
  };

  const withData = students.filter((row) => row.stats?.percent !== null && row.stats?.percent !== undefined);
  const below = withData.filter((row) => row.stats.percent < (course.settings?.minAttendancePercent ?? 75)).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Students" value={students.length} />
        <StatTile label="Upcoming" value={upcoming.length} />
        <StatTile label="Minimum" value={`${course.settings?.minAttendancePercent ?? 75}%`} />
        <StatTile label="Below minimum" value={below} tone={below ? "bg-red-200" : "bg-white"} />
      </div>

      {joinCode && (
        <div className="flex flex-col gap-2 border-2 border-black bg-yellow-50 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[10px] font-black uppercase">Join code</div>
            <div className="font-mono text-2xl font-black tracking-[0.3em]">{joinCode}</div>
            <div className="text-[10px] font-semibold text-gray-600">Students enter it in MY ATTENDANCE → JOIN COURSE.</div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={copy} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" /> COPY
            </button>
            {!archived && (
              <button type="button" onClick={() => setConfirm("regenerate")} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> REGENERATE
              </button>
            )}
          </div>
        </div>
      )}

      <section>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 border-b-2 border-black pb-1">
          <h4 className="text-xs font-black uppercase">Upcoming classes</h4>
          {!archived && (
            <button type="button" onClick={() => openPanel("teacher.schedule", { courseId: course._id, create: true })} className="btn-primary px-2 py-1 text-[10px]">
              <CalendarPlus className="h-3 w-3" aria-hidden="true" /> SCHEDULE
            </button>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="text-[11px] font-semibold text-gray-500">No upcoming classes. Schedule one or add a weekly timetable.</p>
        ) : (
          <ul className="space-y-1.5">
            {upcoming.map((session) => {
              const status = sessionStatus(session, now);
              return (
                <li key={session._id} className="flex flex-col gap-1.5 border-2 border-black p-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-black uppercase">{istDayHeading(session.startsAt)}</span>
                      <StatusBadge kind="session" status={status} />
                      <SourceBadge source={session.source} />
                    </div>
                    <SessionMeta session={session} />
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {status === "live" ? (
                      <button type="button" onClick={() => openPanel("teacher.live", { sessionId: session._id })} className="btn-primary px-2 py-1 text-[10px]">
                        OPEN LIVE
                      </button>
                    ) : canStartNow(session, now) ? (
                      <button type="button" onClick={() => handleStart(session)} disabled={startingId === session._id} className="btn-primary px-2 py-1 text-[10px] disabled:opacity-60">
                        {startingId === session._id ? "STARTING…" : "START"}
                      </button>
                    ) : (
                      <button type="button" onClick={() => openPanel("teacher.schedule", { courseId: course._id, sessionId: session._id })} className="btn-secondary px-2 py-1 text-[10px]">
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

      <div className="flex flex-wrap gap-2 border-t-2 border-black pt-3">
        <button type="button" onClick={() => openPanel("teacher.analytics", { courseId: course._id })} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
          <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" /> ANALYTICS
        </button>
        <button type="button" onClick={() => openPanel("teacher.report", { courseId: course._id })} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
          SESSION REPORTS
        </button>
        {!archived && (
          <button type="button" onClick={() => setConfirm("archive")} className="btn-secondary min-h-11 px-3 text-xs text-red-700 sm:min-h-0">
            <Archive className="h-3.5 w-3.5" aria-hidden="true" /> ARCHIVE
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirm === "regenerate"}
        title="Regenerate join code?"
        body="The current code stops working. Students already enrolled stay enrolled."
        confirmLabel="REGENERATE"
        busy={busy}
        onConfirm={run}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "archive"}
        title={`Archive ${course.code}?`}
        body="Future scheduled classes are called off silently and the course becomes read-only. Attendance records and reports are kept."
        confirmLabel="ARCHIVE"
        danger
        busy={busy}
        onConfirm={run}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function Students({ detail, archived, onRefresh }) {
  const { course, students } = detail;
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [query, setQuery] = useState("");

  const add = async () => {
    const list = parseEmailList(emails);
    if (!list.length) {
      toastError("Paste at least one email address.");
      return;
    }
    setBusy("add");
    try {
      const outcome = await addStudents(course._id, { emails: list });
      setResult({ type: "add", ...outcome });
      toastSuccess(`${outcome.added} student${outcome.added === 1 ? "" : "s"} added`);
      if (!outcome.notFound.length) setEmails("");
      else setEmails(outcome.notFound.join("\n"));
      onRefresh();
    } catch (error) {
      toastError(teacherError(error, "Couldn't add the students"));
    } finally {
      setBusy(null);
    }
  };

  const runAutoEnroll = async () => {
    setBusy("auto");
    try {
      const outcome = await autoEnroll(course._id);
      setResult({ type: "auto", ...outcome });
      toastSuccess(`${outcome.added} new student${outcome.added === 1 ? "" : "s"} enrolled`);
      onRefresh();
    } catch (error) {
      toastError(teacherError(error, "Couldn't auto-enroll"));
    } finally {
      setBusy(null);
    }
  };

  const confirmRemove = async () => {
    setBusy("remove");
    try {
      await removeStudent(course._id, removing._id);
      toastSuccess(`${studentLabel(removing)} removed from ${course.code}`);
      setRemoving(null);
      onRefresh();
    } catch (error) {
      toastError(teacherError(error, "Couldn't remove the student"));
    } finally {
      setBusy(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const rows = students.filter((s) => !needle || [s.name, s.email, s.rollNumber, s.ggsipuEnrollment].some((v) => String(v ?? "").toLowerCase().includes(needle)));

  return (
    <div className="space-y-4">
      {!archived && (
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Field label="Add by email" hint="Paste emails separated by commas, spaces or new lines. Only registered students can be added.">
            <textarea value={emails} onChange={(event) => setEmails(event.target.value)} rows={3} className="input-stark w-full font-mono text-base sm:text-xs" placeholder={"a.sharma@college.edu\nr.verma@college.edu"} />
          </Field>
          <div className="flex flex-row gap-2 md:flex-col md:justify-end">
            <button type="button" onClick={add} disabled={Boolean(busy)} className="btn-primary min-h-11 flex-1 justify-center px-3 text-xs disabled:opacity-60 md:flex-none">
              {busy === "add" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />} ADD
            </button>
            <button
              type="button"
              onClick={runAutoEnroll}
              disabled={Boolean(busy)}
              title={course.branch || course.department ? "Enroll every student matching the course's branch / section / batch" : "Set the course's branch in Settings first"}
              className="btn-secondary min-h-11 flex-1 justify-center px-3 text-xs disabled:opacity-60 md:flex-none"
            >
              {busy === "auto" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />} AUTO-ENROLL
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="border-2 border-black bg-blue-50 p-2 text-xs">
          {result.type === "auto" ? (
            <span className="font-bold">
              Auto-enroll: {result.added} added{result.matched !== null ? ` (${result.matched} students match ${course.branch || course.department}${course.section ? ` ${course.section}` : ""})` : ""}.
            </span>
          ) : (
            <>
              <span className="font-bold">{result.added} added.</span>
              {result.notFound.length > 0 && (
                <div className="mt-1">
                  <span className="font-black uppercase text-red-700">Not found ({result.notFound.length}):</span>{" "}
                  <span className="font-mono">{result.notFound.join(", ")}</span>
                  <div className="text-[10px] font-semibold text-gray-600">These emails don&apos;t belong to a registered student. Ask them to sign up, or share the join code.</div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {students.length === 0 ? (
        <EmptyState icon={Users} title="No students yet" text="Add students by email, use auto-enroll, or share the join code from the overview." />
      ) : (
        <>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search students" className="input-stark w-full text-base sm:w-64 sm:text-xs" aria-label="Search students" />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse border-2 border-black text-left text-xs">
              <thead>
                <tr className="bg-black text-white uppercase">
                  <th className="border-2 border-black p-2">Roll / Enrolment</th>
                  <th className="border-2 border-black p-2">Name</th>
                  <th className="border-2 border-black p-2">Attended</th>
                  <th className="border-2 border-black p-2">%</th>
                  <th className="border-2 border-black p-2">Standing</th>
                  {!archived && <th className="border-2 border-black p-2"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((student) => (
                  <tr key={student._id}>
                    <td className="border-2 border-black p-2 font-mono text-[11px]">{studentRoll(student) || "—"}</td>
                    <td className="border-2 border-black p-2">
                      <div className="font-bold">{studentLabel(student)}</div>
                      <div className="font-mono text-[10px] text-gray-500">{student.email}</div>
                    </td>
                    <td className="border-2 border-black p-2 tabular-nums">
                      {student.stats ? `${student.stats.attended ?? 0}/${Math.max(0, (student.stats.held ?? 0) - (student.stats.excused ?? 0))}` : "—"}
                    </td>
                    <td className="border-2 border-black p-2 font-black tabular-nums">{student.stats?.percent === null || student.stats?.percent === undefined ? "—" : `${student.stats.percent}%`}</td>
                    <td className="border-2 border-black p-2">
                      <StatusBadge kind="standing" status={student.stats?.status ?? "no-data"} />
                    </td>
                    {!archived && (
                      <td className="border-2 border-black p-1.5">
                        <button type="button" onClick={() => setRemoving(student)} aria-label={`Remove ${studentLabel(student)}`} className="btn-secondary px-2 py-1 text-[10px] text-red-700">
                          <Trash2 className="h-3 w-3" aria-hidden="true" /> REMOVE
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${studentLabel(removing)}?`}
        body={`They leave ${course.code} and stop getting its class notifications. Their past attendance records are kept.`}
        confirmLabel="REMOVE"
        danger
        busy={busy === "remove"}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

function TimetableTab({ course, archived, onRefresh }) {
  const [rows, setRows] = useState(() => courseToForm(course).timetable);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(null);
  const [days, setDays] = useState(String(course.settings?.autoGenerateDays ?? 7));

  const save = async () => {
    const found = validateCourseForm({ ...courseToForm(course), timetable: rows });
    const rowErrors = Object.fromEntries(Object.entries(found).filter(([key]) => key.startsWith("timetable")));
    setErrors(rowErrors);
    if (Object.keys(rowErrors).length) return;
    setBusy("save");
    try {
      const result = await updateCourseWithMeta(course._id, { timetable: timetableToPayload(rows) });
      const created = result.timetable?.created ?? 0;
      const removed = result.timetable?.removed ?? 0;
      toastSuccess(`Timetable saved${created ? ` · ${created} class${created === 1 ? "" : "es"} scheduled` : ""}${removed ? ` · ${removed} old slot${removed === 1 ? "" : "s"} removed` : ""}`);
      onRefresh();
    } catch (error) {
      toastError(teacherError(error, "Couldn't save the timetable"));
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 60) {
      toastError("Days must be 1–60.");
      return;
    }
    setBusy("generate");
    try {
      const result = await generateSessions(course._id, { days: value });
      if (result.created) toastSuccess(`${result.created} class${result.created === 1 ? "" : "es"} scheduled — students were notified`);
      else toastInfo("Every timetable slot in that range already has a class");
      onRefresh();
    } catch (error) {
      toastError(teacherError(error, "Couldn't generate classes"));
    } finally {
      setBusy(null);
    }
  };

  const summary = (course.timetable || []).map((slot) => `${WEEKDAYS[slot.day]} ${slot.start}`).join(", ");

  return (
    <div className="space-y-4">
      <p className="text-[11px] font-semibold text-gray-600">
        Weekly slots in IST. Saving re-creates upcoming timetable classes (moved or cancelled ones are left alone) and notifies students once.
        {summary && <span className="block font-mono text-black">Current: {summary}</span>}
      </p>
      <TimetableEditor rows={rows} onChange={setRows} errors={errors} disabled={archived} />
      {!archived && (
        <div className="flex flex-col gap-3 border-t-2 border-black pt-3 sm:flex-row sm:items-end sm:justify-between">
          <button type="button" onClick={save} disabled={Boolean(busy)} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
            {busy === "save" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />} SAVE TIMETABLE
          </button>
          <div className="flex items-end gap-2">
            <Field label="Days ahead">
              <input type="number" min={1} max={60} value={days} onChange={(event) => setDays(event.target.value)} className="input-stark w-24 text-base sm:text-xs" />
            </Field>
            <button type="button" onClick={generate} disabled={Boolean(busy) || !(course.timetable || []).length} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-50 sm:min-h-0">
              {busy === "generate" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />} GENERATE CLASSES
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsTab({ course, archived, onRefresh }) {
  const [form, setForm] = useState(() => courseToForm(course));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    const found = validateCourseForm({ ...form, autoEnroll: false });
    const relevant = Object.fromEntries(Object.entries(found).filter(([key]) => !key.startsWith("timetable")));
    setErrors(relevant);
    if (Object.keys(relevant).length) return;
    const body = formToPayload(form, { create: false });
    delete body.timetable;
    setBusy(true);
    try {
      await updateCourseWithMeta(course._id, body);
      toastSuccess("Course updated");
      onRefresh();
    } catch (error) {
      const field = error?.details?.field;
      if (field) setErrors((current) => ({ ...current, [field]: teacherError(error) }));
      toastError(teacherError(error, "Couldn't save the course"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5" noValidate>
      <DetailsFields form={form} setForm={setForm} errors={errors} disabled={archived} />
      <div className="border-t-2 border-black pt-3">
        <h4 className="mb-2 text-xs font-black uppercase">Attendance settings</h4>
        <SettingsFields settings={form.settings} onChange={(settings) => setForm((current) => ({ ...current, settings }))} errors={errors} disabled={archived} />
      </div>
      {!archived && (
        <div className="flex justify-end border-t-2 border-black pt-3">
          <button type="submit" disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />} SAVE CHANGES
          </button>
        </div>
      )}
    </form>
  );
}
