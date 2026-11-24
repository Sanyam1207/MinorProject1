import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { sendAnnouncement } from "../../lib/api/admin.js";
import { Field, Modal, toastSuccess } from "../../ui/index.js";
import { splitList } from "./mappers.js";

const ROLES = [
  { id: "student", label: "Students" },
  { id: "teacher", label: "Faculty" },
  { id: "alumni", label: "Alumni" },
  { id: "company", label: "Recruiters" },
];
const inputClass = "input-stark w-full text-base sm:text-xs";

function AnnouncementBody({ onClose, defaults }) {
  const [form, setForm] = useState({
    title: defaults?.title ?? "",
    body: defaults?.body ?? "",
    roles: ["student"],
    branch: "",
    passingYear: "",
    email: true,
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const toggleRole = (role) =>
    setForm((current) => ({
      ...current,
      roles: current.roles.includes(role) ? current.roles.filter((value) => value !== role) : [...current.roles, role],
    }));

  const submit = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.body.trim()) {
      setError("Title and message are required.");
      return;
    }
    if (form.roles.length === 0) {
      setError("Pick at least one audience.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const audience = { roles: form.roles };
      const branches = splitList(form.branch);
      const years = splitList(form.passingYear);
      if (branches.length) audience.branch = branches;
      if (years.length) audience.passingYear = years;
      const result = await sendAnnouncement({ title: form.title.trim(), body: form.body.trim(), audience, email: form.email });
      toastSuccess(`Announcement sent to ${result?.recipients ?? 0} people`);
      onClose();
    } catch (failure) {
      setError(failure?.message || "Could not send the announcement");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      title="SEND ANNOUNCEMENT"
      onClose={sending ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={sending} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="tpo-announcement-form" disabled={sending} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {sending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            SEND
          </button>
        </>
      }
    >
      <form id="tpo-announcement-form" onSubmit={submit} className="space-y-3">
        <Field label="Title *">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={140} className={inputClass} />
        </Field>
        <Field label="Message *" hint={`${form.body.length}/1000`}>
          <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={5} maxLength={1000} className={inputClass} />
        </Field>
        <div>
          <span className="mb-1 block text-xs font-extrabold uppercase">Audience</span>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((role) => (
              <label key={role.id} className={`badge-stark cursor-pointer px-2 py-1 ${form.roles.includes(role.id) ? "bg-black text-white" : "bg-white"}`}>
                <input type="checkbox" className="sr-only" checked={form.roles.includes(role.id)} onChange={() => toggleRole(role.id)} />
                {role.label.toUpperCase()}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Branches" hint="Optional, comma separated">
            <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Passing years" hint="Optional, comma separated">
            <input value={form.passingYear} onChange={(e) => setForm({ ...form, passingYear: e.target.value })} className={inputClass} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs font-bold">
          <input type="checkbox" checked={form.email} onChange={(e) => setForm({ ...form, email: e.target.checked })} className="h-4 w-4 accent-black" />
          Also send by email
        </label>
        {error && <p role="alert" className="border-2 border-black bg-red-50 p-2 text-[11px] font-bold text-red-800">{error}</p>}
      </form>
    </Modal>
  );
}

export default function AnnouncementForm({ open, onClose, defaults }) {
  if (!open) return null;
  return <AnnouncementBody onClose={onClose} defaults={defaults} />;
}
