import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Code2, Download, FilePlus2, LoaderCircle, PanelRight, Play, RefreshCw } from "lucide-react";
import { toastError, toastInfo, toastSuccess } from "../ui/index.js";
import { openPanel } from "../workspace/index.js";
import { createResume } from "../lib/api/resumes.js";
import { useLatexCompiler } from "../features/resume/hooks.js";
import PdfPreview from "../features/resume/PdfPreview.jsx";
import { downloadBlob } from "../features/resume/labUtils.js";

const STATUS_LABELS = {
  idle: "WAITING TO START",
  collecting: "COLLECTING DETAILS",
  streaming: "GENERATING LATEX",
  complete: "LATEX COMPLETE",
  analysis: "ANALYSIS READY",
  error: "GENERATION FAILED",
};

/**
 * AI resume generator workspace `({ workspace, onStart, saveTitle? })`.
 * LaTeX streams on the left; once complete it is compiled by our own server
 * (POST /resumes/compile) — or `workspace.pdfUrl` is shown when the agent sent one.
 * SAVE TO CATALOG creates a LaTeX resume and opens it in the editor.
 */
export default function ResumeGeneratorWorkspace({ workspace, onStart, saveTitle = "Generated resume" }) {
  const codeEndRef = useRef(null);
  const lastCompiled = useRef(null);
  const [saving, setSaving] = useState(false);
  const compiler = useLatexCompiler();
  const { compile } = compiler;
  const latexCode = workspace?.latexCode || "";
  const status = workspace?.status || "idle";
  const lines = latexCode ? latexCode.split("\n") : [];
  const externalPdf = workspace?.pdfUrl || null;
  const complete = status === "complete" && Boolean(latexCode.trim());

  useLayoutEffect(() => {
    if (status === "streaming") codeEndRef.current?.scrollIntoView({ block: "end" });
  }, [latexCode, status]);

  // Compile once per completed document (unless the agent already sent a PDF).
  useEffect(() => {
    if (!complete || externalPdf || lastCompiled.current === latexCode) return;
    lastCompiled.current = latexCode;
    compile(latexCode);
  }, [complete, externalPdf, latexCode, compile]);

  const compileNow = () => {
    lastCompiled.current = latexCode;
    compile(latexCode);
  };

  const saveToCatalog = async () => {
    setSaving(true);
    try {
      const { resume, created } = await createResume({ title: saveTitle, kind: "latex", content: latexCode, makePrimary: false });
      if (created) toastSuccess("Saved to your resume catalog");
      else toastInfo("This resume is already in your catalog");
      if (resume?.id) openPanel("resume.lab", { tab: "editor", resumeId: resume.id });
    } catch (error) {
      toastError(error, "Could not save to the catalog");
    } finally {
      setSaving(false);
    }
  };

  const busy = status === "streaming" || status === "collecting";
  const pdfUrl = externalPdf || compiler.pdfUrl;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-2 border-black bg-[#eef1f4] shadow-bold-sm">
      <div className="flex shrink-0 flex-col justify-between gap-3 border-b-2 border-black bg-white px-3 py-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <div className="bg-black p-1.5 text-white">
            <Code2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xs font-black uppercase">Resume generator</h2>
            <p className="text-[10px] font-semibold text-gray-500">main.tex · AI-assisted LaTeX workspace</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge-stark text-[9px] ${status === "complete" ? "bg-green-200" : status === "error" ? "bg-red-100" : "bg-yellow-100"}`}>
            {status === "streaming" && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {status === "complete" && <Check className="h-3 w-3" aria-hidden="true" />}
            {STATUS_LABELS[status] || STATUS_LABELS.idle}
          </span>
          <button type="button" onClick={() => downloadBlob(latexCode, "resume.tex", "application/x-tex")} disabled={!latexCode} className="btn-secondary px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40">
            <Download className="h-3 w-3" aria-hidden="true" /> .TEX
          </button>
          <button type="button" onClick={compileNow} disabled={!latexCode.trim() || busy || compiler.compiling} className="btn-secondary px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40">
            <RefreshCw className={`h-3 w-3 ${compiler.compiling ? "animate-spin" : ""}`} aria-hidden="true" /> COMPILE
          </button>
          <button type="button" onClick={saveToCatalog} disabled={!complete || saving} className="btn-secondary px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <FilePlus2 className="h-3 w-3" aria-hidden="true" />} SAVE TO CATALOG
          </button>
          <button type="button" onClick={onStart} disabled={busy} className="btn-primary px-2 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-50">
            <Play className="h-3 w-3" aria-hidden="true" /> {latexCode ? "CONTINUE IN CHAT" : "START GENERATOR"}
          </button>
        </div>
      </div>
      {workspace?.error && status === "error" && (
        <p role="alert" className="shrink-0 border-b-2 border-black bg-red-50 px-3 py-1.5 text-[11px] font-bold text-red-800">
          {typeof workspace.error === "string" ? workspace.error : workspace.error?.message || "Generation failed."}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-2 xl:overflow-hidden">
        <section className="flex min-h-[480px] flex-col overflow-hidden border-b-2 border-black bg-[#17191c] text-gray-100 xl:min-h-0 xl:border-b-0 xl:border-r-2">
          <div className="flex shrink-0 items-center justify-between border-b border-gray-600 bg-[#24272b] px-3 py-2">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase">
              <Code2 className="h-3.5 w-3.5" aria-hidden="true" /> LaTeX source
            </div>
            <span className="font-mono text-[9px] text-gray-400">{lines.length || 0} LINES</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5">
            {latexCode ? (
              <div className="grid min-w-max grid-cols-[auto_1fr] py-3">
                <div className="select-none border-r border-gray-700 px-3 text-right text-gray-600">
                  {lines.map((_, index) => (
                    <div key={index}>{index + 1}</div>
                  ))}
                </div>
                <pre className="m-0 whitespace-pre px-4 text-gray-100">
                  {latexCode}
                  <span ref={codeEndRef} />
                </pre>
              </div>
            ) : (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center p-8 text-center">
                <Code2 className="mb-3 h-9 w-9 text-gray-600" aria-hidden="true" />
                <p className="text-xs font-bold text-gray-300">LaTeX will stream here incrementally.</p>
                <p className="mt-1 max-w-xs text-[10px] leading-relaxed text-gray-500">
                  Start the generator, answer the assistant’s questions, and the document source appears token by token.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="flex min-h-[480px] flex-col overflow-hidden xl:min-h-0">
          <div className="flex shrink-0 items-center justify-between border-b-2 border-black bg-white px-3 py-2">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase">
              <PanelRight className="h-3.5 w-3.5" aria-hidden="true" /> PDF preview
            </div>
            <span className="text-[9px] font-bold text-gray-500">
              {compiler.compiling ? "COMPILING PDF" : pdfUrl ? "PDF READY" : "COMPILES AFTER LATEX COMPLETES"}
            </span>
          </div>
          <PdfPreview
            url={pdfUrl}
            compiling={compiler.compiling}
            error={externalPdf ? null : compiler.error}
            texErrors={externalPdf ? 0 : compiler.texErrors}
            emptyText={status === "streaming" ? "PDF compilation starts once the complete document is received." : "Your compiled resume appears here after generation finishes."}
          />
        </section>
      </div>
    </div>
  );
}
