import { FileOutput, LoaderCircle, TriangleAlert } from "lucide-react";
import { errorMessage } from "../../lib/http.js";

const COMPILE_HINTS = {
  LATEX_FORBIDDEN: "This document uses a command that isn't allowed (file or shell access). Remove it and compile again.",
  COMPILER_BUSY: "The compiler is busy. Try again in a moment.",
  TOO_MANY_ATTEMPTS: "Too many compiles in a minute. Wait a moment and try again.",
  COMPILER_UNAVAILABLE: "The LaTeX compiler is not available on this server right now.",
  LATEX_COMPILE_TIMEOUT: "Compilation took too long. Simplify the document and try again.",
};

/** Compiler error with the server log (`details.log`, `details.line`). */
export function CompileError({ error }) {
  if (!error) return null;
  const log = typeof error.details?.log === "string" ? error.details.log : "";
  const line = Number(error.details?.line);
  return (
    <div role="alert" className="border-2 border-black bg-red-50 p-3 text-left">
      <div className="flex items-center gap-1.5 text-[11px] font-black uppercase text-red-800">
        <TriangleAlert className="h-4 w-4" aria-hidden="true" />
        Compile failed{Number.isFinite(line) && line > 0 ? ` · line ${line}` : ""}
      </div>
      <p className="mt-1 text-[11px] font-semibold text-gray-800">{COMPILE_HINTS[error.code] || errorMessage(error, "The LaTeX could not be compiled.")}</p>
      {log && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words border border-black bg-white p-2 font-mono text-[10px] leading-4 text-gray-800">
          {log}
        </pre>
      )}
    </div>
  );
}

/** PDF preview pane: iframe of an object URL, compile status, errors. */
export default function PdfPreview({ url, compiling = false, error = null, texErrors = 0, emptyText = "The preview appears here once the LaTeX compiles." }) {
  return (
    <div className="flex min-h-[420px] min-w-0 flex-1 flex-col gap-2 bg-[#d9dde2] p-3 lg:min-h-0">
      {(compiling || texErrors > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {compiling && (
            <span className="badge-stark bg-yellow-100 text-[9px]">
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> COMPILING
            </span>
          )}
          {texErrors > 0 && !compiling && (
            <span className="badge-stark bg-yellow-200 text-[9px]" title="Reported by the compiler (X-Latex-Errors)">
              {texErrors} LATEX WARNING{texErrors === 1 ? "" : "S"}
            </span>
          )}
        </div>
      )}
      <CompileError error={error} />
      {url ? (
        <iframe title="Compiled resume PDF" src={url} className="block min-h-[400px] w-full flex-1 border-2 border-black bg-white lg:min-h-0" />
      ) : (
        <div className="flex flex-1 items-center justify-center border-2 border-dashed border-gray-500 bg-white p-6 text-center">
          {compiling ? (
            <div>
              <LoaderCircle className="mx-auto mb-2 h-8 w-8 animate-spin" aria-hidden="true" />
              <p className="text-xs font-black uppercase">Compiling with Tectonic…</p>
            </div>
          ) : (
            <div>
              <FileOutput className="mx-auto mb-2 h-8 w-8 text-gray-400" aria-hidden="true" />
              <p className="text-[11px] font-semibold text-gray-600">{emptyText}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
