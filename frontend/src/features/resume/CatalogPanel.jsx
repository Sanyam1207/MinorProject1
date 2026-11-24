import { useState } from "react";
import {
  ArchiveRestore,
  Copy,
  ExternalLink,
  FilePlus2,
  Files,
  FileText,
  Gauge,
  PencilLine,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, Panel, Tabs, formatDate, toastError, toastInfo, toastSuccess } from "../../ui/index.js";
import { deleteResume, duplicateResume, getResumeAccess, restoreResume, setPrimaryResume } from "../../lib/api/resumes.js";
import { useResumeCatalog } from "./hooks.js";
import NewResumeModal from "./NewResumeModal.jsx";
import { formatBytes, kindLabel, openPendingTab, originLabel, scoreTone } from "./labUtils.js";

const STATUS_TABS = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
];

function RowButton({ icon: Icon, label, onClick, disabled, danger = false, primary = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${primary ? "btn-primary" : "btn-secondary"} min-h-9 px-2 py-1 text-[10px] disabled:opacity-40 ${danger ? "hover:bg-red-100" : ""}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

function ResumeRow({ resume, busy, onOpen, onAction, archived }) {
  return (
    <li className={`border-2 border-black p-3 ${resume.isPrimary ? "bg-yellow-50" : "bg-white"}`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="shrink-0 bg-black p-2 text-white">
          <FileText className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-black uppercase">{resume.title}</span>
            {resume.isPrimary && <span className="badge-stark bg-black text-[9px] text-white">PRIMARY</span>}
            <span className="badge-stark text-[9px]">{kindLabel(resume.kind)}</span>
            {resume.origin && <span className="badge-stark bg-gray-100 text-[9px] uppercase">{originLabel(resume.origin)}</span>}
            {resume.locked && <span className="badge-stark bg-blue-100 text-[9px]" title="Shared or submitted — duplicate it to edit">LOCKED</span>}
            {Number.isFinite(resume.atsScore) && <span className={`badge-stark text-[9px] tabular-nums ${scoreTone(resume.atsScore)}`}>ATS {resume.atsScore}</span>}
          </div>
          <p className="mt-0.5 text-[10px] font-semibold text-gray-500">
            {resume.version ? `v${resume.version} · ` : ""}
            {formatBytes(resume.sizeBytes)} · updated {formatDate(resume.updatedAt)} · created {formatDate(resume.createdAt)}
          </p>
          {resume.targetJob && (resume.targetJob.title || resume.targetJob.roleTitle) && (
            <p className="mt-0.5 truncate text-[10px] font-bold text-gray-600">
              Tailored for {resume.targetJob.title || resume.targetJob.roleTitle}
              {resume.targetJob.company || resume.targetJob.companyName ? ` · ${resume.targetJob.company || resume.targetJob.companyName}` : ""}
            </p>
          )}
          {resume.extractionWarning && <p className="mt-1 border-l-4 border-orange-400 pl-2 text-[10px] font-semibold text-orange-900">{resume.extractionWarning}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {archived ? (
          <RowButton icon={ArchiveRestore} label="RESTORE" primary disabled={busy} onClick={() => onAction("restore", resume)} />
        ) : (
          <>
            <RowButton icon={PencilLine} label="OPEN" primary disabled={busy} onClick={() => onOpen("editor", resume)} />
            <RowButton icon={Sparkles} label="TAILOR" disabled={busy} onClick={() => onOpen("tailor", resume)} />
            <RowButton icon={Gauge} label="SCORE" disabled={busy} onClick={() => onOpen("ats", resume)} />
            {!resume.isPrimary && <RowButton icon={Star} label="SET PRIMARY" disabled={busy} onClick={() => onAction("primary", resume)} />}
            <RowButton icon={Copy} label="DUPLICATE" disabled={busy} onClick={() => onAction("duplicate", resume)} />
          </>
        )}
        <RowButton icon={ExternalLink} label={resume.hasPdf ? "VIEW PDF" : `VIEW ${kindLabel(resume.kind)}`} disabled={busy} onClick={() => onAction("view", resume)} />
        {!archived && <RowButton icon={Trash2} label="DELETE" danger disabled={busy} onClick={() => onAction("delete", resume)} />}
      </div>
    </li>
  );
}

/** `resume.lab` tab "catalog": list, upload, create, delete (confirm), restore, set primary, duplicate. */
export default function CatalogPanel({ onNavigate, onChanged }) {
  const [status, setStatus] = useState("active");
  const { data, loading, error, reload } = useResumeCatalog({ status });
  const [busyId, setBusyId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [creating, setCreating] = useState(false);
  const resumes = data?.resumes ?? [];
  const archived = status === "archived";

  const open = (tab, resume) => onNavigate?.({ tab, resumeId: resume.id });

  const run = async (resume, task, success) => {
    setBusyId(resume.id);
    try {
      const result = await task();
      if (success) toastSuccess(typeof success === "function" ? success(result) : success);
      reload();
      onChanged?.();
      return result;
    } catch (requestError) {
      toastError(requestError);
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const onAction = (action, resume) => {
    if (action === "delete") return setConfirmDelete(resume);
    if (action === "primary") return run(resume, () => setPrimaryResume(resume.id), `“${resume.title}” is now your primary resume`);
    if (action === "duplicate") return run(resume, () => duplicateResume(resume.id), (copy) => `Created “${copy?.title || "copy"}”`);
    if (action === "restore") return run(resume, () => restoreResume(resume.id), `“${resume.title}” restored`);
    if (action === "view") {
      const tab = openPendingTab();
      const variant = resume.hasPdf ? "pdf" : "original";
      return getResumeAccess(resume.id, { variant })
        .then((access) => tab.go(access.url))
        .catch((requestError) => {
          tab.close();
          toastError(requestError, "Could not open the file");
        });
    }
    return undefined;
  };

  const confirmDeletion = async () => {
    const resume = confirmDelete;
    if (!resume) return;
    const result = await run(resume, () => deleteResume(resume.id));
    setConfirmDelete(null);
    if (result?.archived) toastInfo(`“${resume.title}” was shared or submitted, so it was archived instead of deleted`);
    else if (result?.deleted) toastSuccess(`“${resume.title}” deleted`);
  };

  const count = Number.isFinite(data?.limit) && !archived ? `${resumes.length} / ${data.limit}` : `${resumes.length}`;

  return (
    <Panel
      title="Resume catalog"
      icon={Files}
      badge={loading && !data ? "…" : count}
      actions={
        <button type="button" onClick={() => setCreating(true)} className="btn-primary min-h-9 px-2.5 py-1 text-[10px]">
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" /> NEW RESUME
        </button>
      }
    >
      <Tabs tabs={STATUS_TABS} value={status} onChange={setStatus} className="mb-3" label="Resume status" />
      {error && !data ? (
        <ErrorState error={error} title="COULD NOT LOAD RESUMES" onRetry={reload} />
      ) : loading && !data ? (
        <LoadingState label="LOADING RESUMES…" />
      ) : resumes.length === 0 ? (
        archived ? (
          <EmptyState icon={ArchiveRestore} title="No archived resumes" text="Resumes that were shared or submitted are archived instead of deleted." />
        ) : (
          <EmptyState
            icon={Files}
            title="Your catalog is empty"
            text="Upload a PDF, DOCX or TeX resume, paste LaTeX, or generate one with AI."
            action={
              <>
                <button type="button" onClick={() => setCreating(true)} className="btn-primary px-3 py-1.5 text-xs">
                  NEW RESUME
                </button>
                <button type="button" onClick={() => onNavigate?.({ tab: "generator" })} className="btn-secondary px-3 py-1.5 text-xs">
                  OPEN GENERATOR
                </button>
              </>
            }
          />
        )
      ) : (
        <ul className="space-y-2">
          {resumes.map((resume) => (
            <ResumeRow key={resume.id} resume={resume} busy={busyId === resume.id} onOpen={open} onAction={onAction} archived={archived || resume.status !== "active"} />
          ))}
        </ul>
      )}

      <NewResumeModal
        open={creating}
        defaultPrimary={!archived && resumes.length === 0}
        onClose={() => setCreating(false)}
        onCreated={(resume) => {
          setCreating(false);
          reload();
          onChanged?.();
          if (resume?.id && resume.editable) open("editor", resume);
        }}
      />
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete resume?"
        danger
        busy={Boolean(confirmDelete) && busyId === confirmDelete?.id}
        confirmLabel="DELETE"
        body={
          confirmDelete?.locked
            ? `“${confirmDelete?.title}” was shared or submitted, so it will be archived (you can restore it later).`
            : `“${confirmDelete?.title}” and its files will be permanently deleted.`
        }
        onConfirm={confirmDeletion}
        onCancel={() => setConfirmDelete(null)}
      />
    </Panel>
  );
}
