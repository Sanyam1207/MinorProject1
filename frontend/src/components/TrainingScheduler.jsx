import { useMemo, useState } from "react";
import { Ban, BookOpen, Calendar, Clock, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import {
  cancelProgram,
  createProgram,
  deleteProgram,
  listProgramEnrollments,
  listPrograms,
  markProgramAttendance,
  updateProgram,
  updateProgramEnrollment,
} from "../lib/api/admin.js";
import { useSocketEvent } from "../lib/realtime.js";
import {
  DELIVERY_MODES,
  PROGRAM_STATUS_COLORS,
  TRAINING_TYPES,
  emptyProgramForm,
  emptySession,
  humanize,
  programToForm,
  seatPercent,
  toProgramPayload,
  validateProgramForm,
} from "../features/tpo/mappers.js";
import { ColorBadge, DataTable, KpiTile, SearchBox, SelectBox, Td } from "../features/tpo/parts.jsx";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Panel,
  Tabs,
  formatDate,
  toastError,
  toastSuccess,
  useAsync,
} from "../ui/index.js";
import { usePanel } from "../workspace/index.js";

const inputClass = "input-stark w-full text-base sm:text-xs";
const COMPLETION = ["enrolled", "in-progress", "completed", "dropped"];

function ProgramForm({ program, onClose, onSaved }) {
  const isEdit = Boolean(program?._id);
  const [form, setForm] = useState(() => (isEdit ? programToForm(program) : emptyProgramForm()));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setSession = (index, key, value) =>
    setForm((current) => ({ ...current, schedule: current.schedule.map((session, i) => (i === index ? { ...session, [key]: value } : session)) }));

  const submit = async (event) => {
    event.preventDefault();
    const found = validateProgramForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const payload = toProgramPayload(form);
      const saved = isEdit ? await updateProgram(program._id, payload) : await createProgram(payload);
      toastSuccess(isEdit ? "Program updated. Registered students were notified of changes." : "Program created");
      onSaved(saved);
    } catch (failure) {
      const field = failure?.details?.field;
      if (field) setErrors((current) => ({ ...current, [String(field).split(".")[0]]: failure.message }));
      toastError(failure, "Could not save the program");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={isEdit ? "EDIT PROGRAM" : "NEW TRAINING PROGRAM"}
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">CANCEL</button>
          <button type="submit" form="tpo-program-form" disabled={saving} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} {isEdit ? "SAVE" : "CREATE"}
          </button>
        </>
      }
    >
      <form id="tpo-program-form" onSubmit={submit} noValidate className="space-y-3">
        <Field label="Title *" error={errors.title}>
          <input value={form.title} onChange={set("title")} maxLength={200} className={inputClass} />
        </Field>
        <Field label="Description">
          <textarea value={form.description} onChange={set("description")} rows={3} maxLength={5000} className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Type">
            <select value={form.type} onChange={set("type")} className={inputClass}>
              {TRAINING_TYPES.map((type) => <option key={type} value={type}>{humanize(type)}</option>)}
            </select>
          </Field>
          <Field label="Delivery">
            <select value={form.deliveryMode} onChange={set("deliveryMode")} className={inputClass}>
              {DELIVERY_MODES.map((mode) => <option key={mode} value={mode}>{humanize(mode)}</option>)}
            </select>
          </Field>
          <Field label="Capacity *" error={errors.capacity}>
            <input type="number" inputMode="numeric" min="1" step="1" value={form.capacity} onChange={set("capacity")} className={inputClass} />
          </Field>
          <Field label="Register by">
            <input type="date" value={form.registrationDeadline} onChange={set("registrationDeadline")} className={inputClass} />
          </Field>
        </div>
        <Field label="Instructor">
          <input value={form.instructor} onChange={set("instructor")} maxLength={120} className={inputClass} />
        </Field>
        <fieldset className="border-2 border-black p-3">
          <legend className="px-1 text-xs font-black uppercase">Audience (empty = everyone)</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Branches" hint="Comma separated"><input value={form.branches} onChange={set("branches")} className={inputClass} /></Field>
            <Field label="Graduation years" hint="Comma separated"><input value={form.graduationYears} onChange={set("graduationYears")} className={inputClass} /></Field>
            <Field label="Min CGPA" error={errors.minCgpa}><input type="number" step="0.1" min="0" max="10" value={form.minCgpa} onChange={set("minCgpa")} className={inputClass} /></Field>
          </div>
        </fieldset>
        <fieldset className="border-2 border-black p-3">
          <legend className="px-1 text-xs font-black uppercase">Schedule *</legend>
          {errors.schedule && <p role="alert" className="mb-2 text-[11px] font-bold text-red-700">{errors.schedule}</p>}
          <div className="space-y-2">
            {form.schedule.map((session, index) => (
              <div key={index} className="grid grid-cols-2 gap-2 border border-black bg-gray-50 p-2 sm:grid-cols-[1fr_1fr_1fr_2fr_5rem_auto]">
                <input type="date" aria-label={`Session ${index + 1} date`} value={session.date} onChange={(event) => setSession(index, "date", event.target.value)} className={inputClass} />
                <input aria-label="Time" placeholder="10:00-12:00" value={session.time} onChange={(event) => setSession(index, "time", event.target.value)} maxLength={40} className={inputClass} />
                <input aria-label="Venue" placeholder="Venue" value={session.venue} onChange={(event) => setSession(index, "venue", event.target.value)} maxLength={200} className={inputClass} />
                <input aria-label="Topic" placeholder="Topic" value={session.topic} onChange={(event) => setSession(index, "topic", event.target.value)} maxLength={200} className={inputClass} />
                <input type="number" aria-label="Minutes" placeholder="Min" min="15" max="600" value={session.durationMinutes} onChange={(event) => setSession(index, "durationMinutes", event.target.value)} className={inputClass} />
                <button
                  type="button"
                  aria-label={`Remove session ${index + 1}`}
                  disabled={form.schedule.length <= 1}
                  onClick={() => setForm((current) => ({ ...current, schedule: current.schedule.filter((_, i) => i !== index) }))}
                  className="btn-secondary justify-center px-2 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          {form.schedule.length < 60 && (
            <button type="button" onClick={() => setForm((current) => ({ ...current, schedule: [...current.schedule, emptySession()] }))} className="btn-secondary mt-2 px-3 py-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> ADD SESSION
            </button>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

function RosterModal({ program, onClose }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading, reload } = useAsync(() => listProgramEnrollments(program._id), [program._id, refreshKey]);
  const schedule = data?.program?.schedule ?? program.schedule ?? [];
  const [sessionIndex, setSessionIndex] = useState(0);
  const [busy, setBusy] = useState(null);
  const enrollments = (data?.enrollments ?? []).filter((entry) => entry.status !== "cancelled");

  const toggleAttendance = async (studentIds, present) => {
    setBusy(studentIds.length > 1 ? "all" : studentIds[0]);
    try {
      await markProgramAttendance(program._id, { sessionIndex, studentIds, present });
      setRefreshKey((key) => key + 1);
    } catch (failure) {
      toastError(failure, "Could not save attendance");
    } finally {
      setBusy(null);
    }
  };

  const setCompletion = async (entry, completionStatus) => {
    setBusy(entry._id);
    try {
      await updateProgramEnrollment(program._id, entry._id, { completionStatus });
      setRefreshKey((key) => key + 1);
    } catch (failure) {
      toastError(failure, "Could not update the enrollment");
    } finally {
      setBusy(null);
    }
  };

  const presentIn = (entry) => (entry.attendance ?? []).some((mark) => mark.sessionIndex === sessionIndex);

  return (
    <Modal open size="lg" title={`ROSTER — ${program.title}`} onClose={onClose}>
      {loading && !data ? (
        <LoadingState label="LOADING ROSTER…" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : enrollments.length === 0 ? (
        <EmptyState icon={Users} title="No registrations yet" />
      ) : (
        <div className="space-y-3">
          {schedule.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <SelectBox
                label="Session"
                value={String(sessionIndex)}
                onChange={(value) => setSessionIndex(Number(value))}
                options={schedule.map((session, index) => ({ value: String(index), label: `#${index + 1} · ${formatDate(session.date)}${session.time ? ` ${session.time}` : ""}${session.topic ? ` · ${session.topic}` : ""}` }))}
              />
              <button type="button" disabled={busy !== null} onClick={() => toggleAttendance(enrollments.map((entry) => entry.student._id), true)} className="btn-secondary px-2 py-1 text-[10px]">
                {busy === "all" && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />} MARK ALL PRESENT
              </button>
            </div>
          ) : (
            <p className="text-[11px] font-bold text-gray-600">This program has no sessions, so attendance cannot be marked.</p>
          )}
          <DataTable head={["Student", "Branch / year", "Present", "Sessions", "Completion"]}>
            {enrollments.map((entry) => (
              <tr key={entry._id}>
                <Td>
                  <div className="font-black uppercase">{entry.student?.name}</div>
                  <div className="font-mono text-[10px] text-gray-600">{entry.student?.rollNumber || entry.student?.email}</div>
                </Td>
                <Td className="text-[11px] font-semibold">{entry.student?.branch || "—"} · {entry.student?.passingYear || "—"}</Td>
                <Td>
                  {schedule.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label={`Present: ${entry.student?.name}`}
                      checked={presentIn(entry)}
                      disabled={busy !== null}
                      onChange={(event) => toggleAttendance([entry.student._id], event.target.checked)}
                      className="h-5 w-5 accent-black"
                    />
                  )}
                </Td>
                <Td className="tabular-nums">{(entry.attendance ?? []).length}/{schedule.length}</Td>
                <Td>
                  <select
                    value={entry.completionStatus}
                    disabled={busy !== null}
                    aria-label={`Completion for ${entry.student?.name}`}
                    onChange={(event) => setCompletion(entry, event.target.value)}
                    className="input-stark py-1 text-base sm:text-[11px]"
                  >
                    {COMPLETION.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                  </select>
                </Td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </Modal>
  );
}

/** TPO training scheduler (`tpo.training`): programs CRUD, sessions, roster and attendance. */
export default function TrainingScheduler() {
  const { params, setParams } = usePanel("tpo.training");
  const [status, setStatus] = useState("active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [roster, setRoster] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const apiStatus = status === "active" ? "upcoming,ongoing" : status;
  const { data, error, loading, reload } = useAsync(() => listPrograms({ status: apiStatus, q: query || undefined }), [apiStatus, query, refreshKey]);
  const programs = useMemo(() => data ?? [], [data]);
  useSocketEvent("placement:training", () => setRefreshKey((key) => key + 1));

  const stats = useMemo(() => ({
    sessions: programs.reduce((sum, program) => sum + (program.schedule?.length ?? 0), 0),
    enrolled: programs.reduce((sum, program) => sum + (Number(program.enrolledCount) || 0), 0),
  }), [programs]);

  const formOpen = editing !== null || Boolean(params.create);

  const runConfirm = async (reason) => {
    const { action, program } = confirm;
    setBusy(true);
    try {
      if (action === "cancel") {
        await cancelProgram(program._id, reason ? { reason } : {});
        toastSuccess("Program cancelled. Registered students were notified.");
      } else {
        await deleteProgram(program._id);
        toastSuccess("Program deleted");
      }
      setConfirm(null);
      setRefreshKey((key) => key + 1);
    } catch (failure) {
      toastError(failure, failure?.code === "HAS_ENROLLMENTS" ? "Students are registered — cancel the program instead." : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Training scheduler"
      icon={BookOpen}
      badge={`${programs.length} PROGRAMS`}
      actions={
        <>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh programs" className="btn-secondary px-2 py-1 text-[10px]">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setEditing({})} className="btn-primary px-2 py-1 text-[10px]">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> NEW PROGRAM
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <KpiTile label="Programs" value={programs.length} accent="bg-blue-50" />
          <KpiTile label="Registered" value={stats.enrolled} accent="bg-green-50" />
          <KpiTile label="Sessions" value={stats.sessions} accent="bg-yellow-50" />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={status}
            onChange={setStatus}
            label="Program status"
            tabs={[{ id: "active", label: "Upcoming & ongoing" }, { id: "completed", label: "Completed" }, { id: "cancelled", label: "Cancelled" }, { id: "all", label: "All" }]}
          />
          <SearchBox value={query} onSearch={setQuery} placeholder="Search programs" className="sm:w-64" />
        </div>
        {loading && !data ? (
          <LoadingState label="LOADING PROGRAMS…" />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : programs.length === 0 ? (
          <EmptyState icon={BookOpen} title="No programs" text="Create a training program with at least one session." />
        ) : (
          <DataTable head={["Program", "Type", "Next session", "Seats", "Status", "Actions"]}>
            {programs.map((program) => {
              // Guard against an empty schedule / zero capacity (legacy data).
              const next = program.nextSession ?? program.schedule?.[0] ?? null;
              const pct = seatPercent(program.enrolledCount, program.capacity);
              return (
                <tr key={program._id} className={params.programId === program._id ? "bg-yellow-50" : "hover:bg-gray-50"}>
                  <Td>
                    <div className="font-black uppercase">{program.title}</div>
                    <div className="text-[10px] font-semibold text-gray-600">{program.instructor || "Instructor TBA"} · {humanize(program.deliveryMode)} · {program.schedule?.length ?? 0} sessions</div>
                  </Td>
                  <Td><ColorBadge color="bg-blue-100">{humanize(program.type)}</ColorBadge></Td>
                  <Td className="whitespace-nowrap">
                    {next ? (
                      <>
                        <span className="flex items-center gap-1"><Calendar className="h-3 w-3" aria-hidden="true" /> {formatDate(next.date)}</span>
                        <span className="flex items-center gap-1 text-[10px] text-gray-600"><Clock className="h-3 w-3" aria-hidden="true" /> {next.time || "Time TBA"} · {next.venue || "TBA"}</span>
                      </>
                    ) : (
                      <span className="text-gray-500">Schedule TBA</span>
                    )}
                  </Td>
                  <Td className="min-w-28">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 flex-1 border border-black bg-gray-100"><span className="block h-full bg-black" style={{ width: `${pct}%` }} /></span>
                      <span className="font-mono text-[10px] font-bold">{program.enrolledCount ?? 0}/{program.capacity ?? 0}</span>
                    </div>
                  </Td>
                  <Td><ColorBadge color={PROGRAM_STATUS_COLORS[program.status]}>{program.status}</ColorBadge></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" onClick={() => setRoster(program)} className="btn-secondary px-1.5 py-1 text-[10px]">
                        <Users className="h-3.5 w-3.5" aria-hidden="true" /> ROSTER
                      </button>
                      {program.status !== "cancelled" && program.status !== "completed" && (
                        <>
                          <button type="button" onClick={() => setEditing(program)} aria-label={`Edit ${program.title}`} className="btn-secondary px-1.5 py-1">
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => setConfirm({ action: "cancel", program })} aria-label={`Cancel ${program.title}`} className="btn-secondary px-1.5 py-1 text-red-700">
                            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </>
                      )}
                      {!(program.enrolledCount > 0) && (
                        <button type="button" onClick={() => setConfirm({ action: "delete", program })} aria-label={`Delete ${program.title}`} className="btn-secondary px-1.5 py-1 text-red-700">
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </div>

      {formOpen && (
        <ProgramForm
          key={editing?._id ?? "new"}
          program={editing?._id ? editing : null}
          onClose={() => {
            setEditing(null);
            if (params.create) setParams({ ...params, create: undefined }, { replace: true });
          }}
          onSaved={(saved) => {
            setEditing(null);
            setParams({ ...params, create: undefined, programId: saved?._id }, { replace: true });
            setRefreshKey((key) => key + 1);
          }}
        />
      )}
      {roster && <RosterModal key={roster._id} program={roster} onClose={() => setRoster(null)} />}
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.action === "cancel" ? "CANCEL PROGRAM?" : "DELETE PROGRAM?"}
        body={confirm?.action === "cancel" ? "Registered students are notified. This cannot be undone." : "Permanently removes a program nobody has registered for."}
        confirmLabel={confirm?.action === "cancel" ? "CANCEL PROGRAM" : "DELETE"}
        cancelLabel="KEEP"
        danger
        busy={busy}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </Panel>
  );
}
