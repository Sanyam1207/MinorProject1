import { useState } from "react";
import { FileText, LoaderCircle, Send } from "lucide-react";
import { applyToJob } from "../../lib/api/placements.js";
import { errorMessage } from "../../lib/http.js";
import { Field, Modal, toastSuccess, useAsync } from "../../ui/index.js";
import { formatLpa } from "../../ui/format.js";
import { openPanel } from "../../workspace/index.js";
import { listResumeOptions } from "./resumeOptions.js";
import { invalidateOpportunitySummary } from "./summary.js";

const COVER_MAX = 1000;

function ApplyForm({ job, onClose, onApplied }) {
  const resumes = useAsync(listResumeOptions, []);
  const [resumeId, setResumeId] = useState("");
  const [coverNote, setCoverNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const options = resumes.data?.items ?? [];
  const primary = options.find((item) => item.id === resumes.data?.primaryId) ?? null;

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const application = await applyToJob(job.id, { resumeId: resumeId || undefined, coverNote });
      invalidateOpportunitySummary();
      toastSuccess(`Applied to ${job.roleTitle} at ${job.companyName}`);
      onApplied?.(application);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "Could not submit your application."));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      title={`APPLY · ${job.companyName}`}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="apply-form" disabled={busy} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
            SUBMIT APPLICATION
          </button>
        </>
      }
    >
      <form id="apply-form" onSubmit={submit} className="space-y-4">
        <div className="border-[1.5px] border-black bg-gray-50 p-3">
          <div className="text-[10px] font-extrabold uppercase text-gray-600">{job.companyName}</div>
          <div className="text-sm font-black uppercase">{job.roleTitle}</div>
          <div className="mt-1 text-[11px] font-bold text-gray-700">
            {formatLpa(job.packageLpa ?? job.salaryText)}
            {job.location ? ` · ${job.location}` : ""}
          </div>
          {job.isEligible === false && job.eligibilityReasons[0] && (
            <p className="mt-2 text-[11px] font-semibold text-red-800">{job.eligibilityReasons[0]}</p>
          )}
        </div>

        <Field
          label="Resume"
          hint={
            resumes.loading
              ? "Loading your resumes…"
              : options.length
                ? "Recruiters see the resume you pick. Default: your primary resume."
                : "No saved resumes found — your primary resume (if any) is attached automatically."
          }
        >
          <select
            value={resumeId}
            onChange={(event) => setResumeId(event.target.value)}
            disabled={busy || resumes.loading || options.length === 0}
            className="input-stark w-full text-base sm:text-xs"
          >
            <option value="">{primary ? `Primary resume — ${primary.title}` : "Primary resume (default)"}</option>
            {options.map((resume) => (
              <option key={resume.id} value={resume.id}>
                {resume.title}
                {resume.version ? ` · v${resume.version}` : ""}
                {resume.kind ? ` · ${String(resume.kind).toUpperCase()}` : ""}
              </option>
            ))}
          </select>
        </Field>
        {!resumes.loading && options.length === 0 && (
          <button
            type="button"
            onClick={() => {
              onClose();
              openPanel("resume.lab", { tab: "catalog" });
            }}
            className="btn-secondary px-2 py-1 text-[10px]"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            OPEN RESUME LAB
          </button>
        )}

        <Field label="Cover note (optional)" hint={`${coverNote.length}/${COVER_MAX}`}>
          <textarea
            value={coverNote}
            onChange={(event) => setCoverNote(event.target.value.slice(0, COVER_MAX))}
            rows={5}
            maxLength={COVER_MAX}
            disabled={busy}
            placeholder="Why are you a good fit for this role?"
            className="input-stark w-full text-base sm:text-xs"
          />
        </Field>

        {error && (
          <p role="alert" className="border-2 border-black bg-red-50 p-2 text-[11px] font-bold text-red-800">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Campus in-portal apply: resume picker + cover note → POST /jobs/:id/apply. */
export default function ApplyDialog({ open, job, onClose, onApplied }) {
  if (!open || !job) return null;
  return <ApplyForm job={job} onClose={onClose} onApplied={onApplied} />;
}
