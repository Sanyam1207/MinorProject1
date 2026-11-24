import { useState } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { createDrive, updateDrive } from "../../lib/api/admin.js";
import { Field, Modal, toastError, toastSuccess } from "../../ui/index.js";
import { EMPLOYMENT_TYPES, driveToForm, emptyDriveForm, emptyRound, toDrivePayload, validateDriveForm } from "./mappers.js";

const inputClass = "input-stark w-full text-base sm:text-xs";

function DriveFormBody({ scope, drive, onClose, onSaved }) {
  const isEdit = Boolean(drive?._id);
  const [original] = useState(() => (isEdit ? driveToForm(drive) : null));
  const [form, setForm] = useState(() => (isEdit ? driveToForm(drive) : emptyDriveForm()));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setRound = (index, key, value) =>
    setForm((current) => ({ ...current, rounds: current.rounds.map((round, i) => (i === index ? { ...round, [key]: value } : round)) }));

  const submit = async (event) => {
    event.preventDefault();
    const found = validateDriveForm(form, { scope, isEdit });
    setErrors(found);
    if (Object.keys(found).length) {
      toastError("Please fix the highlighted fields.");
      return;
    }
    setSaving(true);
    try {
      const payload = toDrivePayload(form, { scope, isEdit, original });
      if (isEdit) {
        const job = await updateDrive(drive._id, payload);
        toastSuccess("Drive updated");
        onSaved?.(job);
      } else {
        const { job, notifiedStudents } = await createDrive(payload);
        if (scope === "company" || job?.status === "pending") toastSuccess("Drive submitted. The placement office will review it.");
        else if (job?.status === "draft") toastSuccess("Draft saved");
        else toastSuccess(Number.isFinite(notifiedStudents) ? `Drive published. ${notifiedStudents} eligible students notified.` : "Drive published");
        onSaved?.(job);
      }
    } catch (error) {
      const field = error?.details?.field;
      if (field) {
        const key = { applicationDeadline: "deadline", minimumCgpa: "minCgpa", maximumBacklogs: "maxBacklogs", eligibleBranches: "branches", min10thPercentage: "min10th", min12thPercentage: "min12th" }[field] ?? field;
        setErrors((current) => ({ ...current, [key]: error.message }));
      }
      toastError(error, "Could not save the drive");
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit ? "EDIT DRIVE" : scope === "company" ? "POST A DRIVE" : "NEW PLACEMENT DRIVE";

  return (
    <Modal
      open
      size="lg"
      title={title}
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="tpo-drive-form" disabled={saving} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {isEdit ? "SAVE CHANGES" : scope === "company" ? "SUBMIT FOR REVIEW" : form.status === "draft" ? "SAVE DRAFT" : "PUBLISH DRIVE"}
          </button>
        </>
      }
    >
      <form id="tpo-drive-form" onSubmit={submit} noValidate className="space-y-4">
        {scope === "company" && !isEdit && (
          <p className="border-2 border-black bg-yellow-100 p-2 text-[11px] font-bold">
            Drives you post are reviewed by the placement office before students can see them.
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Role title *" error={errors.title}>
            <input value={form.title} onChange={set("title")} maxLength={300} className={inputClass} placeholder="e.g. Software Engineer (SDE-1)" />
          </Field>
          {scope !== "company" && (
            <Field label={isEdit ? "Company" : "Company *"} error={errors.companyName}>
              <input value={form.companyName} onChange={set("companyName")} maxLength={200} className={inputClass} placeholder="e.g. Infosys" />
            </Field>
          )}
        </div>
        <Field label={isEdit ? "Description" : "Description *"} error={errors.description}>
          <textarea value={form.description} onChange={set("description")} rows={5} maxLength={20000} className={inputClass} placeholder="Responsibilities, team, tech stack…" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Package / CTC" hint='e.g. "12 LPA" or "8-12 LPA"' error={errors.packageLpa}>
            <input value={form.packageLpa} onChange={set("packageLpa")} maxLength={100} className={inputClass} />
          </Field>
          <Field label="Location" error={errors.location}>
            <input value={form.location} onChange={set("location")} maxLength={200} className={inputClass} placeholder="e.g. Bengaluru / Hybrid" />
          </Field>
          <Field label="Employment type">
            <input value={form.employmentType} onChange={set("employmentType")} list="tpo-employment-types" maxLength={60} className={inputClass} />
            <datalist id="tpo-employment-types">
              {EMPLOYMENT_TYPES.map((type) => <option key={type} value={type} />)}
            </datalist>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Application deadline" hint="Applications close at the end of this day." error={errors.deadline}>
            <input type="date" value={form.deadline} onChange={set("deadline")} className={inputClass} />
          </Field>
          <Field label="Drive date" error={errors.driveDate}>
            <input type="date" value={form.driveDate} min={form.deadline || undefined} onChange={set("driveDate")} className={inputClass} />
          </Field>
        </div>

        <fieldset className="border-2 border-black p-3">
          <legend className="px-1 text-xs font-black uppercase">Eligibility</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Min CGPA" error={errors.minCgpa}>
              <input type="number" inputMode="decimal" step="0.1" min="0" max="10" value={form.minCgpa} onChange={set("minCgpa")} className={inputClass} />
            </Field>
            <Field label="Max backlogs" error={errors.maxBacklogs}>
              <input type="number" inputMode="numeric" step="1" min="0" max="50" value={form.maxBacklogs} onChange={set("maxBacklogs")} className={inputClass} />
            </Field>
            <Field label="Min 10th %" error={errors.min10th}>
              <input type="number" inputMode="decimal" min="0" max="100" value={form.min10th} onChange={set("min10th")} className={inputClass} />
            </Field>
            <Field label="Min 12th %" error={errors.min12th}>
              <input type="number" inputMode="decimal" min="0" max="100" value={form.min12th} onChange={set("min12th")} className={inputClass} />
            </Field>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Eligible branches" hint="Comma separated. Empty = all branches." error={errors.branches}>
              <input value={form.branches} onChange={set("branches")} className={inputClass} placeholder="CSE, IT, ECE" />
            </Field>
            <Field label="Graduation years" hint="Comma separated, e.g. 2026, 2027" error={errors.graduationYears}>
              <input value={form.graduationYears} onChange={set("graduationYears")} className={inputClass} />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Skills" hint="Comma separated" error={errors.skills}>
              <input value={form.skills} onChange={set("skills")} className={inputClass} placeholder="Java, SQL, React" />
            </Field>
          </div>
        </fieldset>

        <Field label="Selection process">
          <textarea value={form.selectionProcess} onChange={set("selectionProcess")} rows={2} maxLength={5000} className={inputClass} placeholder="Online test → technical interview → HR" />
        </Field>

        <fieldset className="border-2 border-black p-3">
          <legend className="px-1 text-xs font-black uppercase">Rounds</legend>
          {form.rounds.length === 0 && <p className="text-[11px] font-semibold text-gray-500">No rounds scheduled yet.</p>}
          <div className="space-y-3">
            {form.rounds.map((round, index) => (
              <div key={index} className="border border-black bg-gray-50 p-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_2fr_1fr_auto]">
                  <Field label={`Round ${index + 1} name`} error={errors[`round${index}`]}>
                    <input value={round.name} onChange={(event) => setRound(index, "name", event.target.value)} maxLength={120} className={inputClass} placeholder="Online test" />
                  </Field>
                  <Field label="When">
                    <input type="datetime-local" value={round.at} onChange={(event) => setRound(index, "at", event.target.value)} className={inputClass} />
                  </Field>
                  <Field label="Mode">
                    <select value={round.mode} onChange={(event) => setRound(index, "mode", event.target.value)} className={inputClass}>
                      <option value="offline">Offline</option>
                      <option value="online">Online</option>
                    </select>
                  </Field>
                  <div className="flex items-end">
                    <button
                      type="button"
                      aria-label={`Remove round ${index + 1}`}
                      onClick={() => setForm((current) => ({ ...current, rounds: current.rounds.filter((_, i) => i !== index) }))}
                      className="btn-secondary min-h-11 px-2 sm:min-h-0 sm:py-2"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input value={round.venue} onChange={(event) => setRound(index, "venue", event.target.value)} maxLength={200} aria-label="Venue" placeholder="Venue / link" className={inputClass} />
                  <input value={round.notes} onChange={(event) => setRound(index, "notes", event.target.value)} maxLength={500} aria-label="Notes" placeholder="Notes" className={inputClass} />
                </div>
              </div>
            ))}
          </div>
          {form.rounds.length < 10 && (
            <button
              type="button"
              onClick={() => setForm((current) => ({ ...current, rounds: [...current.rounds, emptyRound()] }))}
              className="btn-secondary mt-3 px-3 py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> ADD ROUND
            </button>
          )}
        </fieldset>

        {scope !== "company" && !isEdit && (
          <Field label="Publish">
            <select value={form.status} onChange={set("status")} className={inputClass}>
              <option value="active">Publish now (notify eligible students)</option>
              <option value="draft">Save as draft</option>
            </select>
          </Field>
        )}
      </form>
    </Modal>
  );
}

/** Create / edit drive dialog. `drive` = StaffJobView to edit (omit to create). */
export default function DriveForm({ open, scope = "tpo", drive = null, onClose, onSaved }) {
  if (!open) return null;
  return <DriveFormBody key={drive?._id ?? "new"} scope={scope} drive={drive} onClose={onClose} onSaved={onSaved} />;
}
