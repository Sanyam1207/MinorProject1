import { useRef, useState } from "react";
import { ClipboardPaste, FileText, Gauge, LoaderCircle, Upload } from "lucide-react";
import { EmptyState, LoadingState, toastError, toastInfo, toastSuccess } from "../ui/index.js";
import {
  RESUME_MAX_UPLOAD_BYTES,
  RESUME_UPLOAD_ACCEPT,
  RESUME_UPLOAD_EXTENSIONS,
  previewResumeScore,
  uploadAndScoreResume,
} from "../lib/api/resumes.js";
import ScoreView from "../features/resume/ScoreView.jsx";

const extensionOf = (name) => String(name || "").split(".").pop()?.toLowerCase() ?? "";

/**
 * Deterministic ATS score card (RESUME-BYOK §5.3 ScoreResult).
 *   scoreData        ScoreResult | null (no fake default rubric: empty state when null)
 *   onResumeUploaded called with the upload response (ScoreResult & {created})
 *   loading, jobId, jobSource (score uploads against a job), embedded (no own card header)
 * Uploads accept PDF / DOCX / TeX / TXT; pasted text is scored with the preview
 * endpoint and never stored.
 */
export default function ResumeScoreCard({ scoreData = null, onResumeUploaded, loading = false, jobId, jobSource, embedded = false }) {
  const [local, setLocal] = useState(null);
  const [busy, setBusy] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const fileInput = useRef(null);

  // A local upload/preview result is shown until newer scoreData arrives.
  const shown = local && local.basis === scoreData ? local : null;
  const result = shown?.result ?? scoreData;

  const upload = async (file) => {
    if (!file) return;
    setError("");
    if (!RESUME_UPLOAD_EXTENSIONS.includes(extensionOf(file.name))) {
      setError("Upload a PDF, DOCX, TeX or TXT file.");
      return;
    }
    if (file.size > RESUME_MAX_UPLOAD_BYTES) {
      setError("That file is larger than 5 MB.");
      return;
    }
    setBusy("upload");
    try {
      const response = await uploadAndScoreResume({ file, jobId: jobId || undefined, jobSource: jobId ? jobSource : undefined });
      setLocal({ basis: scoreData, result: response, kind: "upload" });
      if (response?.created === false) toastInfo("This resume was already uploaded — showing its score");
      else toastSuccess("Resume uploaded and scored");
      onResumeUploaded?.(response);
    } catch (requestError) {
      setError(requestError?.message || "Failed to upload and score the resume.");
      toastError(requestError, "Failed to upload and score the resume");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const preview = async () => {
    if (!pasted.trim()) return;
    setBusy("preview");
    setError("");
    try {
      const response = await previewResumeScore({ text: pasted, jobId: jobId || undefined, jobSource: jobId ? jobSource : undefined });
      setLocal({ basis: scoreData, result: response, kind: "preview" });
    } catch (requestError) {
      setError(requestError?.message || "Could not score that text.");
    } finally {
      setBusy(null);
    }
  };

  const body = (
    <div className="space-y-4">
      {error && <div className="border-2 border-black bg-red-100 p-2.5 text-xs font-bold text-red-900">{error}</div>}
      {shown?.kind === "preview" && <span className="badge-stark bg-yellow-100 text-[10px]">PREVIEW — NOT SAVED</span>}

      {loading && !shown ? (
        <LoadingState label="SCORING RESUME…" />
      ) : result ? (
        <ScoreView result={result} />
      ) : (
        <EmptyState icon={Gauge} title="Nothing scored yet" text="Upload a resume or add one to your catalog to see its ATS score, keyword coverage and fixes." />
      )}

      <div className="border-t-2 border-black pt-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            upload(event.dataTransfer.files?.[0]);
          }}
          className={`border-2 border-dashed border-black p-4 text-center ${dragOver ? "bg-yellow-100" : "bg-gray-50"}`}
        >
          <Upload className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          <p className="mb-1 text-xs font-bold uppercase">{busy === "upload" ? "Uploading & scoring…" : "Drop a resume to upload & score"}</p>
          <p className="mb-3 text-[11px] font-semibold text-gray-600">PDF, DOCX, TeX or TXT · it is added to your catalog{jobId ? " and scored against the selected job" : ""}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
              {busy === "upload" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FileText className="h-3.5 w-3.5" aria-hidden="true" />}
              SELECT RESUME FILE
            </button>
            <button type="button" onClick={() => setPasteOpen((value) => !value)} disabled={Boolean(busy)} className="btn-secondary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
              <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" /> PASTE TEXT TO PREVIEW
            </button>
          </div>
          <input ref={fileInput} type="file" accept={RESUME_UPLOAD_ACCEPT} className="hidden" onChange={(event) => upload(event.target.files?.[0])} />
        </div>
        {pasteOpen && (
          <div className="mt-3 space-y-2">
            <textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={7}
              placeholder="Paste your resume text — it is scored but not saved."
              aria-label="Resume text to preview"
              className="input-stark w-full resize-y text-base sm:text-xs"
            />
            <button type="button" onClick={preview} disabled={!pasted.trim() || Boolean(busy)} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50">
              {busy === "preview" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              SCORE THIS TEXT
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) return body;
  return (
    <section className="card-stark bg-white">
      <div className="mb-4 flex items-center justify-between border-b-2 border-black pb-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5" aria-hidden="true" />
          <h2 className="text-sm font-black uppercase">Automated resume score</h2>
        </div>
        <span className="badge-stark bg-yellow-200 text-[10px]">ATS RUBRIC</span>
      </div>
      {body}
    </section>
  );
}
