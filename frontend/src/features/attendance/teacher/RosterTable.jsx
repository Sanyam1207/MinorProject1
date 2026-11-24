import { useState } from "react";
import { LoaderCircle, MessageSquarePlus, Search, Users } from "lucide-react";
import EmptyState from "../../../ui/EmptyState.jsx";
import Field from "../../../ui/Field.jsx";
import Modal from "../../../ui/Modal.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import Tabs from "../../../ui/Tabs.jsx";
import { istTime } from "./ist.js";
import { studentLabel, studentRoll } from "./liveState.js";

const STATUSES = ["present", "late", "absent", "excused"];
const SHORT = { present: "P", late: "L", absent: "A", excused: "E" };
const TONE = { present: "bg-green-200", late: "bg-yellow-200", absent: "bg-red-200", excused: "bg-blue-100" };

const FLAG_LABELS = {
  "low-accuracy-geo": "LOW GPS ACCURACY",
  "new-device": "NEW PHONE",
};

/**
 * Session roster with status, method, time, flags and (when `canMark`)
 * manual P / L / A / E buttons + a note dialog.
 * onMark(studentId, status, note?) → Promise
 */
export default function RosterTable({ roster = [], canMark = false, onMark, newestFirst = false }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(null);
  const [noteFor, setNoteFor] = useState(null);

  const counts = { all: roster.length, unmarked: 0, present: 0, late: 0, absent: 0, excused: 0 };
  for (const row of roster) counts[row.record?.status ?? "unmarked"] += 1;

  const needle = query.trim().toLowerCase();
  let rows = roster.filter((row) => {
    const status = row.record?.status ?? "unmarked";
    if (filter !== "all" && status !== filter) return false;
    if (!needle) return true;
    const s = row.student || {};
    return [s.name, s.email, s.rollNumber, s.ggsipuEnrollment].some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
  if (newestFirst) {
    rows = [...rows].sort((a, b) => new Date(b.record?.markedAt ?? 0) - new Date(a.record?.markedAt ?? 0));
  }

  const mark = async (studentId, status, note) => {
    setBusy(`${studentId}:${status}`);
    try {
      await onMark?.(studentId, status, note);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!roster.length) {
    return <EmptyState icon={Users} title="No students in this class" text="Add students to the course (by email, join code or auto-enroll) to see them here." />;
  }

  return (
    <div>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={filter}
          onChange={setFilter}
          label="Filter by status"
          tabs={[
            { id: "all", label: "All", count: counts.all },
            { id: "present", label: "Present", count: counts.present },
            { id: "late", label: "Late", count: counts.late },
            { id: "absent", label: "Absent", count: counts.absent },
            { id: "excused", label: "Excused", count: counts.excused },
            { id: "unmarked", label: "Not marked", count: counts.unmarked },
          ]}
        />
        <label className="relative block sm:w-56">
          <span className="sr-only">Search students</span>
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or roll no." className="input-stark w-full pl-7 text-base sm:text-xs" />
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse border-2 border-black text-left text-xs">
          <thead>
            <tr className="bg-black text-white uppercase">
              <th className="border-2 border-black p-2">Roll / Enrolment</th>
              <th className="border-2 border-black p-2">Name</th>
              <th className="border-2 border-black p-2">Status</th>
              <th className="border-2 border-black p-2">How</th>
              <th className="border-2 border-black p-2">Time</th>
              {canMark && <th className="border-2 border-black p-2">Mark</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const s = row.student || {};
              const record = row.record;
              return (
                <tr key={s._id} className="align-top">
                  <td className="border-2 border-black p-2 font-mono text-[11px]">{studentRoll(s) || "—"}</td>
                  <td className="border-2 border-black p-2">
                    <div className="font-bold">{studentLabel(s)}</div>
                    {s.email && <div className="font-mono text-[10px] text-gray-500">{s.email}</div>}
                    {!row.enrolled && row.enrolled !== undefined && <span className="badge-stark mt-0.5 bg-orange-100 text-[9px]">NOT ENROLLED NOW</span>}
                    {record?.note && <div className="mt-0.5 text-[10px] italic text-gray-600">Note: {record.note}</div>}
                  </td>
                  <td className="border-2 border-black p-2">
                    {record ? <StatusBadge kind="attendance" status={record.status} /> : <span className="badge-stark bg-gray-100 text-[10px]">NOT MARKED</span>}
                    {(record?.flags || []).map((flag) => (
                      <span key={flag} className="badge-stark mt-0.5 ml-0.5 bg-orange-100 text-[9px]">
                        {FLAG_LABELS[flag] ?? String(flag).replace(/[-_]/g, " ").toUpperCase()}
                      </span>
                    ))}
                  </td>
                  <td className="border-2 border-black p-2 text-[10px] font-bold uppercase">{record?.method === "auto" ? "auto (no scan)" : record?.method ?? "—"}</td>
                  <td className="border-2 border-black p-2 tabular-nums">{record?.markedAt ? istTime(record.markedAt) : "—"}</td>
                  {canMark && (
                    <td className="border-2 border-black p-1.5">
                      <div className="flex items-center gap-1">
                        {STATUSES.map((status) => {
                          const current = record?.status === status;
                          const loading = busy === `${s._id}:${status}`;
                          return (
                            <button
                              key={status}
                              type="button"
                              title={`Mark ${status}`}
                              aria-label={`Mark ${studentLabel(s)} ${status}`}
                              aria-pressed={current}
                              disabled={Boolean(busy) || current}
                              onClick={() => mark(s._id, status)}
                              className={`flex h-9 w-9 items-center justify-center border-2 border-black text-[11px] font-black sm:h-7 sm:w-7 ${current ? `${TONE[status]} ring-2 ring-black` : "bg-white hover:bg-gray-100"} disabled:cursor-default`}
                            >
                              {loading ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : SHORT[status]}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          title="Mark with a note"
                          aria-label={`Mark ${studentLabel(s)} with a note`}
                          disabled={Boolean(busy)}
                          onClick={() => setNoteFor(row)}
                          className="flex h-9 w-9 items-center justify-center border-2 border-black bg-white hover:bg-gray-100 sm:h-7 sm:w-7"
                        >
                          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="mt-2 text-center text-[11px] font-semibold text-gray-500">No students match.</p>}
      {canMark && (
        <p className="mt-2 text-[10px] font-semibold text-gray-500">P = present · L = late · A = absent · E = excused (not counted against the student). Students are notified of manual changes.</p>
      )}
      {noteFor && (
        <NoteDialog
          row={noteFor}
          onClose={() => setNoteFor(null)}
          onSave={async (status, note) => {
            const ok = await mark(noteFor.student._id, status, note);
            if (ok) setNoteFor(null);
          }}
          busy={Boolean(busy)}
        />
      )}
    </div>
  );
}

function NoteDialog({ row, onClose, onSave, busy }) {
  const [status, setStatus] = useState(row.record?.status ?? "excused");
  const [note, setNote] = useState(row.record?.note ?? "");
  return (
    <Modal
      open
      size="sm"
      title={`Mark ${studentLabel(row.student)}`}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="button" onClick={() => onSave(status, note.trim())} disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} SAVE
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="input-stark w-full text-base sm:text-xs">
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note" hint="e.g. medical leave, scanner trouble (max 300 characters)">
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={300} className="input-stark w-full text-base sm:text-xs" />
        </Field>
      </div>
    </Modal>
  );
}
