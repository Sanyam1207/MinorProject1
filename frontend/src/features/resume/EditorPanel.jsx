import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  Gauge,
  LoaderCircle,
  PencilLine,
  Play,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, toastError, toastInfo, toastSuccess, useAsync } from "../../ui/index.js";
import { createResume, duplicateResume, fetchResumeFile, getResume, getResumeAccess, updateResume } from "../../lib/api/resumes.js";
import { useBeforeUnload, useLatexCompiler, useObjectUrl } from "./hooks.js";
import LatexEditor from "./LatexEditor.jsx";
import PdfPreview from "./PdfPreview.jsx";
import ResumePicker from "./ResumePicker.jsx";
import { downloadBlob, kindLabel, openPendingTab, safeFileName, sourceExtension } from "./labUtils.js";

const AUTO_COMPILE_DELAY_MS = 1500;

function ToolButton({ icon: Icon, label, onClick, disabled, primary = false, spinning = false, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${primary ? "btn-primary" : "btn-secondary"} min-h-9 px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <Icon className={`h-3.5 w-3.5 ${spinning ? "animate-spin" : ""}`} aria-hidden="true" />
      {label}
    </button>
  );
}

/** Original PDF preview for uploaded PDF resumes (owner download as a Blob). */
function usePdfOriginal(resumeId, enabled) {
  const [url, setBlob] = useObjectUrl();
  const { error, loading } = useAsync(
    async () => {
      const blob = await fetchResumeFile(resumeId, { variant: "pdf" });
      setBlob(blob);
      return true;
    },
    [resumeId],
    { enabled },
  );
  return { url, error, loading };
}

function EditorWorkspace({ initial, resumes, onSelect, onDirtyChange, onReload, onNavigate, onChanged }) {
  const [resume, setResume] = useState(initial.resume);
  const [content, setContent] = useState(initial.content);
  const [savedContent, setSavedContent] = useState(initial.content);
  const [titleDraft, setTitleDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [autoCompile, setAutoCompile] = useState(true);
  const compiler = useLatexCompiler();
  const { compile } = compiler;
  const lastCompiled = useRef(initial.content);

  const kind = resume.kind;
  const isLatex = kind === "latex";
  const editableKind = initial.contentKind === "latex" || initial.contentKind === "text";
  const canEdit = editableKind && resume.editable && !resume.locked && resume.status === "active";
  const dirty = canEdit && content !== savedContent;
  const original = usePdfOriginal(resume.id, kind === "pdf");

  useBeforeUnload(dirty);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // First preview: the server's cached PDF for this resume.
  useEffect(() => {
    if (isLatex) compile({ resumeId: initial.resume.id });
  }, [isLatex, compile, initial.resume.id]);

  // Recompile 1.5 s after typing stops.
  useEffect(() => {
    if (!isLatex || !autoCompile || content === lastCompiled.current || !content.trim()) return undefined;
    const timer = setTimeout(() => {
      lastCompiled.current = content;
      compile(content);
    }, AUTO_COMPILE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [content, autoCompile, isLatex, compile]);

  const compileNow = () => {
    lastCompiled.current = content;
    compile(content);
  };

  const save = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      const updated = await updateResume(resume.id, { content, expectedRevision: resume.revision });
      if (updated) setResume((previous) => ({ ...previous, ...updated }));
      setSavedContent(content);
      setConflict(false);
      toastSuccess("Resume saved");
      onChanged?.();
    } catch (error) {
      if (error?.code === "REVISION_CONFLICT") setConflict(true);
      else if (error?.code === "RESUME_LOCKED") setResume((previous) => ({ ...previous, locked: true, editable: false }));
      toastError(error, "Could not save the resume");
    } finally {
      setSaving(false);
    }
  };

  const rename = async () => {
    const title = (titleDraft ?? "").trim();
    if (!title || title === resume.title) return setTitleDraft(null);
    try {
      const updated = await updateResume(resume.id, { title });
      setResume((previous) => ({ ...previous, ...(updated || { title }) }));
      setTitleDraft(null);
      toastSuccess("Renamed");
      onChanged?.();
    } catch (error) {
      toastError(error, "Could not rename the resume");
    }
    return undefined;
  };

  const duplicateToEdit = async () => {
    try {
      const copy = await duplicateResume(resume.id);
      toastSuccess(`Created “${copy?.title || "copy"}” — you can edit it`);
      onChanged?.();
      if (copy?.id) onNavigate?.({ tab: "editor", resumeId: copy.id });
    } catch (error) {
      toastError(error, "Could not duplicate the resume");
    }
  };

  const saveAsNew = async () => {
    try {
      const { resume: created } = await createResume({ title: `${resume.title} (copy)`.slice(0, 200), kind, content, makePrimary: false });
      toastSuccess("Saved as a new resume");
      onChanged?.();
      onDirtyChange?.(false);
      if (created?.id) onNavigate?.({ tab: "editor", resumeId: created.id });
    } catch (error) {
      toastError(error, "Could not save a copy");
    }
  };

  const openOriginal = () => {
    const tab = openPendingTab();
    getResumeAccess(resume.id, { variant: "original" })
      .then((access) => tab.go(access.url))
      .catch((error) => {
        tab.close();
        toastError(error, "Could not open the file");
      });
  };

  const baseName = safeFileName(resume.title);
  const extension = sourceExtension(kind);
  const lineCount = content.split("\n").length;
  const errorLine = Number(compiler.error?.details?.line) || null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-black bg-white"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          save();
        }
      }}
    >
      <div className="shrink-0 space-y-2 border-b-2 border-black p-2.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
            <ResumePicker resumes={resumes} value={resume.id} onChange={(next) => next && next !== resume.id && onSelect(next)} label="Editing" className="w-full sm:w-64" />
            {titleDraft === null ? (
              <button type="button" onClick={() => setTitleDraft(resume.title)} className="btn-secondary min-h-9 px-2 py-1 text-[10px]" disabled={resume.status !== "active"}>
                <PencilLine className="h-3.5 w-3.5" aria-hidden="true" /> RENAME
              </button>
            ) : (
              <form
                className="flex min-w-0 items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename();
                }}
              >
                <input
                  autoFocus
                  value={titleDraft}
                  maxLength={200}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => event.key === "Escape" && setTitleDraft(null)}
                  aria-label="Resume title"
                  className="input-stark w-44 min-w-0 py-1 text-base sm:text-xs"
                />
                <button type="submit" className="btn-primary px-2 py-1 text-[10px]">
                  OK
                </button>
                <button type="button" onClick={() => setTitleDraft(null)} className="btn-secondary px-2 py-1 text-[10px]">
                  CANCEL
                </button>
              </form>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="badge-stark text-[9px]">{kindLabel(kind)}</span>
            <span className="badge-stark font-mono text-[9px]">REV {resume.revision}</span>
            {resume.locked && <span className="badge-stark bg-blue-100 text-[9px]">LOCKED</span>}
            {dirty ? <span className="badge-stark bg-yellow-200 text-[9px]">UNSAVED</span> : canEdit && <span className="badge-stark bg-green-100 text-[9px]">SAVED</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {canEdit && <ToolButton icon={saving ? LoaderCircle : Save} spinning={saving} label="SAVE" primary onClick={save} disabled={!dirty || saving} title="Save (Ctrl/Cmd + S)" />}
          {isLatex && <ToolButton icon={compiler.compiling ? LoaderCircle : Play} spinning={compiler.compiling} label="COMPILE" onClick={compileNow} disabled={compiler.compiling || !content.trim()} />}
          {isLatex && (
            <label className="inline-flex items-center gap-1 text-[10px] font-black uppercase">
              <input type="checkbox" checked={autoCompile} onChange={(event) => setAutoCompile(event.target.checked)} className="h-3.5 w-3.5 accent-black" />
              Auto
            </label>
          )}
          {extension && <ToolButton icon={Download} label={`.${extension.toUpperCase()}`} onClick={() => downloadBlob(content, `${baseName}.${extension}`)} disabled={!content} />}
          {isLatex && <ToolButton icon={Download} label=".PDF" onClick={() => downloadBlob(compiler.pdfBlob, `${baseName}.pdf`)} disabled={!compiler.pdfBlob} />}
          {!editableKind && <ToolButton icon={ExternalLink} label="OPEN ORIGINAL" onClick={openOriginal} />}
          <ToolButton icon={Sparkles} label="TAILOR" onClick={() => onNavigate?.({ tab: "tailor", resumeId: resume.id })} />
          <ToolButton icon={Gauge} label="SCORE" onClick={() => onNavigate?.({ tab: "ats", resumeId: resume.id })} />
        </div>
        {resume.locked && editableKind && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-black bg-blue-50 p-2 text-[11px] font-bold">
            <span>Shared — this version was shared or submitted and is locked. Duplicate it to edit.</span>
            <ToolButton icon={Copy} label="DUPLICATE TO EDIT" primary onClick={duplicateToEdit} />
          </div>
        )}
        {!editableKind && (
          <p className="border-2 border-black bg-gray-50 p-2 text-[11px] font-semibold">
            {kindLabel(kind)} resumes can't be edited here — this is the text ATS systems read from it. Upload a new version to change it.
          </p>
        )}
        {conflict && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-2 border-black bg-orange-100 p-2 text-[11px] font-bold">
            <span className="flex items-center gap-1.5">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" /> This resume changed somewhere else since you opened it.
            </span>
            <span className="flex gap-1.5">
              <ToolButton icon={Save} label="SAVE AS NEW RESUME" primary onClick={saveAsNew} />
              <ToolButton icon={Download} label="LOAD LATEST (DISCARD MINE)" onClick={onReload} />
            </span>
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-2 lg:overflow-hidden">
        <section className="flex min-h-0 flex-col border-b-2 border-black lg:border-b-0 lg:border-r-2">
          <div className="flex shrink-0 items-center justify-between bg-[#24272b] px-3 py-1.5 text-gray-100">
            <span className="text-[10px] font-black uppercase">{editableKind ? `${kindLabel(kind)} source` : "Extracted text"}</span>
            <span className="font-mono text-[9px] text-gray-400 tabular-nums">
              {lineCount} LINES · {content.length.toLocaleString("en-IN")} CHARS
            </span>
          </div>
          <LatexEditor value={content} onChange={canEdit ? setContent : undefined} readOnly={!canEdit} errorLine={errorLine} label={editableKind ? "Resume source" : "Extracted text"} />
        </section>
        <section className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b-2 border-black bg-white px-3 py-1.5">
            <span className="text-[10px] font-black uppercase">PDF preview</span>
            {compiler.ms !== null && isLatex && !compiler.compiling && <span className="font-mono text-[9px] text-gray-500">{Math.round(compiler.ms)} MS</span>}
          </div>
          {isLatex ? (
            <PdfPreview url={compiler.pdfUrl} compiling={compiler.compiling} error={compiler.error} texErrors={compiler.texErrors} />
          ) : kind === "pdf" ? (
            original.error ? (
              <div className="p-3">
                <ErrorState error={original.error} title="COULD NOT LOAD THE PDF" />
              </div>
            ) : (
              <PdfPreview url={original.url} compiling={original.loading} emptyText="Loading the original PDF…" />
            )
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[11px] font-semibold text-gray-600">
              {kind === "docx" ? "DOCX files have no in-app preview. Use OPEN ORIGINAL to download it." : "Plain-text resumes have no PDF preview."}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EditorLoader({ resumeId, ...rest }) {
  const { data, error, loading, reload } = useAsync(() => getResume(resumeId), [resumeId]);
  if (error && !data) return <ErrorState error={error} title="COULD NOT OPEN THIS RESUME" onRetry={reload} />;
  if (loading || !data?.resume) return <LoadingState label="OPENING RESUME…" />;
  return <EditorWorkspace initial={data} {...rest} />;
}

/**
 * `resume.lab` tab "editor" (full-height). Kept mounted while other tabs are
 * shown, so unsaved edits survive tab switches; switching resumes with unsaved
 * changes asks first.
 */
export default function EditorPanel({ resumeId, resumes = [], active = true, onNavigate, onChanged }) {
  const [shownId, setShownId] = useState(resumeId ?? null);
  const [dirty, setDirty] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const wanted = active ? resumeId ?? null : shownId;
  const needsSwitch = wanted !== shownId;
  if (needsSwitch && (!dirty || !shownId)) setShownId(wanted);
  const pendingId = needsSwitch && dirty && shownId ? wanted : null;

  const select = (id) => onNavigate?.({ tab: "editor", resumeId: id });

  if (!shownId) {
    return (
      <div className="card-stark space-y-3 bg-white">
        <ResumePicker resumes={resumes} value={null} onChange={(id) => id && select(id)} label="Choose a resume to edit" />
        <EmptyState
          icon={PencilLine}
          title="No resume open"
          text="Pick a resume above, or add one in the catalog."
          action={
            <button type="button" onClick={() => onNavigate?.({ tab: "catalog" })} className="btn-primary px-3 py-1.5 text-xs">
              OPEN CATALOG
            </button>
          }
        />
      </div>
    );
  }

  return (
    <>
      <EditorLoader
        key={`${shownId}:${reloadKey}`}
        resumeId={shownId}
        resumes={resumes}
        onSelect={select}
        onDirtyChange={setDirty}
        onReload={() => {
          setDirty(false);
          setReloadKey((value) => value + 1);
          toastInfo("Loaded the latest saved version");
        }}
        onNavigate={onNavigate}
        onChanged={onChanged}
      />
      <ConfirmDialog
        open={Boolean(pendingId)}
        title="Discard unsaved changes?"
        body="You have unsaved edits in this resume. Switching resumes will discard them."
        confirmLabel="DISCARD & SWITCH"
        danger
        onConfirm={() => {
          setDirty(false);
          setShownId(pendingId);
        }}
        onCancel={() => select(shownId)}
      />
    </>
  );
}
