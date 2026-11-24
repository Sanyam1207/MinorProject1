import { useRef, useState } from "react";
import { FileCode2, LoaderCircle, Upload } from "lucide-react";
import { Field, Modal, Tabs, toastError, toastInfo, toastSuccess } from "../../ui/index.js";
import {
  RESUME_MAX_UPLOAD_BYTES,
  RESUME_UPLOAD_ACCEPT,
  RESUME_UPLOAD_EXTENSIONS,
  createResume,
  uploadResumeFile,
} from "../../lib/api/resumes.js";
import { formatBytes } from "./labUtils.js";

const MODES = [
  { id: "upload", label: "Upload file" },
  { id: "latex", label: "Write LaTeX" },
];

const LATEX_PLACEHOLDER = "\\documentclass{article}\n\\begin{document}\nYour resume…\n\\end{document}";

const extensionOf = (name) => String(name || "").split(".").pop()?.toLowerCase() ?? "";

/** NEW RESUME dialog: upload PDF / DOCX / TeX / TXT, or paste / load LaTeX. */
export default function NewResumeModal({ open, onClose, onCreated, defaultPrimary = false }) {
  const [mode, setMode] = useState("upload");
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [latex, setLatex] = useState("");
  const [makePrimary, setMakePrimary] = useState(defaultPrimary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef(null);
  const texInput = useRef(null);

  const pickFile = (picked) => {
    setError("");
    if (!picked) return setFile(null);
    if (!RESUME_UPLOAD_EXTENSIONS.includes(extensionOf(picked.name))) {
      setFile(null);
      return setError("Choose a PDF, DOCX, TeX or TXT file. Old .doc files must be saved as PDF or DOCX first.");
    }
    if (picked.size > RESUME_MAX_UPLOAD_BYTES) {
      setFile(null);
      return setError(`That file is ${formatBytes(picked.size)}; the limit is ${formatBytes(RESUME_MAX_UPLOAD_BYTES)}.`);
    }
    setFile(picked);
    if (!title) setTitle(picked.name.replace(/\.[^.]+$/, ""));
    return undefined;
  };

  const loadTex = async (picked) => {
    if (!picked) return;
    setError("");
    if (!/\.(tex|txt)$/i.test(picked.name)) return setError("Choose a .tex file.");
    setLatex(await picked.text());
    if (!title) setTitle(picked.name.replace(/\.[^.]+$/, ""));
    return undefined;
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (mode === "upload" && !file) return setError("Choose a file first.");
    if (mode === "latex" && !latex.trim()) return setError("Paste your LaTeX or load a .tex file first.");
    setBusy(true);
    try {
      const result =
        mode === "upload"
          ? await uploadResumeFile(file, { title: title.trim() || undefined, makePrimary })
          : await createResume({ title: title.trim() || undefined, kind: "latex", content: latex, makePrimary });
      if (result.created) toastSuccess(`“${result.resume?.title}” added to your catalog`);
      else toastInfo("This resume is already in your catalog");
      if (result.resume?.extractionWarning) toastInfo(result.resume.extractionWarning);
      setFile(null);
      setLatex("");
      setTitle("");
      if (fileInput.current) fileInput.current.value = "";
      onCreated?.(result.resume, { mode });
    } catch (requestError) {
      setError(requestError?.message || "Could not add the resume");
      toastError(requestError, "Could not add the resume");
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Modal
      open={open}
      title="New resume"
      size="lg"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="new-resume-form" disabled={busy} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {mode === "upload" ? "UPLOAD" : "CREATE RESUME"}
          </button>
        </>
      }
    >
      <form id="new-resume-form" onSubmit={submit} className="space-y-3">
        <Tabs tabs={MODES} value={mode} onChange={setMode} label="How to add" />
        <Field label="Title" hint="Optional — defaults to the file name.">
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} className="input-stark w-full text-base sm:text-xs" placeholder="Software engineer resume" />
        </Field>

        {mode === "upload" ? (
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              pickFile(event.dataTransfer.files?.[0]);
            }}
            className="border-2 border-dashed border-black bg-gray-50 p-5 text-center"
          >
            <Upload className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
            <p className="text-xs font-black uppercase">{file ? file.name : "Drop a resume here"}</p>
            <p className="mt-1 text-[11px] font-semibold text-gray-600">
              {file ? formatBytes(file.size) : `PDF, DOCX, TeX or TXT · up to ${formatBytes(RESUME_MAX_UPLOAD_BYTES)}`}
            </p>
            <button type="button" onClick={() => fileInput.current?.click()} className="btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              CHOOSE FILE
            </button>
            <input ref={fileInput} type="file" accept={RESUME_UPLOAD_ACCEPT} className="hidden" onChange={(event) => pickFile(event.target.files?.[0])} />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => texInput.current?.click()} className="btn-secondary px-2 py-1 text-[10px]">
                <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" /> LOAD .TEX FILE
              </button>
              <span className="text-[11px] text-gray-500">or paste the LaTeX below</span>
              <input ref={texInput} type="file" accept=".tex,text/plain" className="hidden" onChange={(event) => loadTex(event.target.files?.[0])} />
            </div>
            <textarea
              value={latex}
              onChange={(event) => setLatex(event.target.value)}
              rows={12}
              spellCheck={false}
              placeholder={LATEX_PLACEHOLDER}
              aria-label="LaTeX source"
              className="input-stark w-full resize-y font-mono text-base leading-5 sm:text-[11px]"
            />
          </div>
        )}

        <label className="flex items-center gap-2 text-xs font-bold">
          <input type="checkbox" checked={makePrimary} onChange={(event) => setMakePrimary(event.target.checked)} className="h-4 w-4 accent-black" />
          Make this my primary resume
        </label>
        {error && (
          <p role="alert" className="border-2 border-black bg-red-50 p-2 text-[11px] font-bold text-red-800">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
