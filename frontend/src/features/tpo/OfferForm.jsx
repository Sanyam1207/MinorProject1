import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { createOffer, getApplication, listApplicants, listDrives } from "../../lib/api/admin.js";
import { Field, Modal, toastSuccess, useAsync } from "../../ui/index.js";
import { OFFERABLE_STATUSES } from "./mappers.js";

const inputClass = "input-stark w-full text-base sm:text-xs";

function ApplicationPicker({ value, onChange }) {
  const [jobId, setJobId] = useState("");
  const drives = useAsync(() => listDrives({ status: "active,closed" }), []);
  const applicants = useAsync(
    () => (jobId ? listApplicants(jobId, { status: OFFERABLE_STATUSES.join(","), limit: 200, sort: "name" }) : Promise.resolve({ items: [] })),
    [jobId],
  );
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Drive *" error={drives.error ? drives.error.message : null}>
        <select
          value={jobId}
          onChange={(event) => {
            setJobId(event.target.value);
            onChange(null);
          }}
          className={inputClass}
        >
          <option value="">{drives.loading ? "Loading drives…" : "Pick a drive"}</option>
          {(drives.data?.items ?? []).map((drive) => (
            <option key={drive._id} value={drive._id}>
              {drive.companyName} — {drive.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Applicant *" hint="Applied, shortlisted or interview stage" error={applicants.error ? applicants.error.message : null}>
        <select
          value={value?._id ?? ""}
          disabled={!jobId}
          onChange={(event) => onChange((applicants.data?.items ?? []).find((item) => item._id === event.target.value) ?? null)}
          className={inputClass}
        >
          <option value="">{applicants.loading && jobId ? "Loading applicants…" : "Pick an applicant"}</option>
          {(applicants.data?.items ?? []).map((application) => (
            <option key={application._id} value={application._id}>
              {application.student?.name} ({application.student?.rollNumber || application.student?.email}) — {application.status}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function OfferFormBody({ applicationId, application: initialApplication, onClose, onCreated, allowPicker }) {
  const lookup = useAsync(
    () => (applicationId && !initialApplication ? getApplication(applicationId) : Promise.resolve(initialApplication ?? null)),
    [applicationId],
  );
  const [picked, setPicked] = useState(null);
  const application = picked ?? lookup.data ?? initialApplication ?? null;
  const [mode, setMode] = useState("application");
  const [form, setForm] = useState({
    packageLpa: "",
    roleTitle: "",
    expiresAt: "",
    joiningDate: "",
    location: "",
    offerLetterUrl: "",
    note: "",
    studentId: "",
    companyName: "",
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    const pkg = Number(form.packageLpa);
    if (!(pkg > 0 && pkg <= 500)) {
      setError("Enter the package in LPA (greater than 0, at most 500).");
      return;
    }
    const body = {
      packageLpa: pkg,
      roleTitle: form.roleTitle.trim() || undefined,
      expiresAt: form.expiresAt || undefined,
      joiningDate: form.joiningDate || undefined,
      location: form.location.trim() || undefined,
      offerLetterUrl: form.offerLetterUrl.trim() || undefined,
      note: form.note.trim() || undefined,
    };
    if (mode === "application") {
      if (!application?._id) {
        setError("Pick the applicant to make the offer to.");
        return;
      }
      body.applicationId = application._id;
    } else {
      if (!form.studentId.trim() || !form.companyName.trim() || !form.roleTitle.trim()) {
        setError("Student ID, company and role title are required for an off-campus offer.");
        return;
      }
      body.studentId = form.studentId.trim();
      body.companyName = form.companyName.trim();
    }
    setError(null);
    setSaving(true);
    try {
      const offer = await createOffer(body);
      toastSuccess(`Offer extended to ${offer?.student?.name || application?.student?.name || "the student"}`);
      onCreated?.(offer);
    } catch (failure) {
      setError(failure?.message || "Could not create the offer");
    } finally {
      setSaving(false);
    }
  };

  const offerable = !application || OFFERABLE_STATUSES.includes(application.status);

  return (
    <Modal
      open
      title="EXTEND OFFER"
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="tpo-offer-form" disabled={saving || !offerable} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            EXTEND OFFER
          </button>
        </>
      }
    >
      <form id="tpo-offer-form" onSubmit={submit} className="space-y-3">
        {allowPicker && !applicationId && !initialApplication && (
          <div className="flex gap-1">
            {[
              { id: "application", label: "Campus applicant" },
              { id: "offcampus", label: "Off-campus / PPO" },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setMode(option.id)}
                className={`px-3 py-1.5 text-xs font-black uppercase ${mode === option.id ? "bg-black text-white" : "bg-gray-100 hover:bg-gray-200"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {mode === "application" ? (
          applicationId || initialApplication ? (
            <div className="border-2 border-black bg-gray-50 p-2 text-xs">
              {lookup.loading && !application ? (
                <span className="font-bold">Loading application…</span>
              ) : application ? (
                <>
                  <div className="font-black uppercase">{application.student?.name}</div>
                  <div className="font-semibold text-gray-700">
                    {application.job?.companyName} — {application.job?.title} · status <b>{application.status}</b>
                  </div>
                  {!offerable && <div className="mt-1 font-bold text-red-700">Offers can only be made to applied, shortlisted or interview-stage applicants.</div>}
                </>
              ) : (
                <span className="font-bold text-red-700">{lookup.error?.message || "Application not found."}</span>
              )}
            </div>
          ) : (
            <ApplicationPicker value={picked} onChange={setPicked} />
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Student ID *" hint="The student's account id">
              <input value={form.studentId} onChange={set("studentId")} className={`${inputClass} font-mono`} />
            </Field>
            <Field label="Company *">
              <input value={form.companyName} onChange={set("companyName")} maxLength={200} className={inputClass} />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Package (LPA) *">
            <input type="number" inputMode="decimal" step="0.01" min="0" max="500" value={form.packageLpa} onChange={set("packageLpa")} className={inputClass} />
          </Field>
          <Field label={mode === "application" ? "Role title" : "Role title *"} hint={mode === "application" ? "Defaults to the drive title" : undefined}>
            <input value={form.roleTitle} onChange={set("roleTitle")} maxLength={200} className={inputClass} />
          </Field>
          <Field label="Respond by" hint="Defaults to the policy's offer expiry">
            <input type="date" value={form.expiresAt} onChange={set("expiresAt")} className={inputClass} />
          </Field>
          <Field label="Joining date">
            <input type="date" value={form.joiningDate} onChange={set("joiningDate")} className={inputClass} />
          </Field>
          <Field label="Location">
            <input value={form.location} onChange={set("location")} maxLength={200} className={inputClass} />
          </Field>
          <Field label="Offer letter URL">
            <input type="url" value={form.offerLetterUrl} onChange={set("offerLetterUrl")} className={inputClass} placeholder="https://" />
          </Field>
        </div>
        <Field label="Note">
          <textarea value={form.note} onChange={set("note")} rows={2} maxLength={500} className={inputClass} />
        </Field>
        {error && <p role="alert" className="border-2 border-black bg-red-50 p-2 text-[11px] font-bold text-red-800">{error}</p>}
      </form>
    </Modal>
  );
}

/** Extend-offer dialog: for a known application, or (allowPicker) by picking drive → applicant / off-campus. */
export default function OfferForm({ open, applicationId, application, onClose, onCreated, allowPicker = false }) {
  if (!open) return null;
  return (
    <OfferFormBody
      key={applicationId ?? application?._id ?? "new"}
      applicationId={applicationId}
      application={application}
      onClose={onClose}
      onCreated={onCreated}
      allowPicker={allowPicker}
    />
  );
}
