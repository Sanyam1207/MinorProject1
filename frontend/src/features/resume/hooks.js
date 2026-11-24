// Resume Lab hooks (kept out of .jsx files, FRONTEND.md §1.10).
import { useCallback, useEffect, useRef, useState } from "react";
import { useAsync } from "../../ui/index.js";
import { useSocketEvent } from "../../lib/realtime.js";
import {
  compileLatex,
  listCampusJobsForResume,
  listMarketJobsForResume,
  listResumeCatalog,
  saveGeneratedResume,
} from "../../lib/api/resumes.js";
import { flattenCredentials, listLlmProviders } from "../../lib/api/llm.js";

/** Catalog `{resumes, primaryId, limit}` that refetches on the `resume:changed` socket event. */
export function useResumeCatalog({ status = "active" } = {}) {
  const state = useAsync(() => listResumeCatalog({ status }), [status]);
  const { reload } = state;
  useSocketEvent("resume:changed", reload);
  return state;
}

/** `[url, setBlob]` — an object URL for the latest Blob; the previous URL is revoked. */
export function useObjectUrl() {
  const [url, setUrl] = useState(null);
  const urlRef = useRef(null);
  const setBlob = useCallback((blob) => {
    const next = blob ? URL.createObjectURL(blob) : null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setUrl(next);
  }, []);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );
  return [url, setBlob];
}

/**
 * LaTeX compiler state. `compile(latex | {resumeId})` → resolves true on success.
 * Only the latest call updates state (older results are dropped).
 */
export function useLatexCompiler() {
  const [pdfUrl, setPdfBlob] = useObjectUrl();
  const [pdfBlob, setBlob] = useState(null);
  const [state, setState] = useState({ compiling: false, error: null, texErrors: 0, ms: null, compiledAt: null });
  const seq = useRef(0);

  const compile = useCallback(
    async (source) => {
      seq.current += 1;
      const mine = seq.current;
      setState((previous) => ({ ...previous, compiling: true, error: null }));
      try {
        const result = await compileLatex(source);
        if (mine !== seq.current) return false;
        setPdfBlob(result.blob);
        setBlob(result.blob);
        setState({ compiling: false, error: null, texErrors: result.texErrors, ms: result.ms, compiledAt: Date.now() });
        return true;
      } catch (error) {
        if (mine !== seq.current) return false;
        setState((previous) => ({ ...previous, compiling: false, error }));
        return false;
      }
    },
    [setPdfBlob],
  );

  const reset = useCallback(() => {
    seq.current += 1;
    setPdfBlob(null);
    setBlob(null);
    setState({ compiling: false, error: null, texErrors: 0, ms: null, compiledAt: null });
  }, [setPdfBlob]);

  return { ...state, pdfUrl, pdfBlob, compile, reset };
}

/** BYOK providers + flattened credentials. `disabled` when the server has BYOK off (503 BYOK_DISABLED). */
export function useLlmCredentials() {
  const { data, error, loading, reload } = useAsync(() => listLlmProviders(), []);
  const providers = data ?? [];
  const disabled = error?.code === "BYOK_DISABLED";
  return {
    providers,
    credentials: flattenCredentials(providers),
    loading,
    error: disabled ? null : error,
    disabled,
    reload,
  };
}

/** Jobs for a picker: campus drives or market (job feed) jobs. */
export function usePickerJobs(source) {
  return useAsync(() => (source === "market" ? listMarketJobsForResume() : listCampusJobsForResume()), [source]);
}

/** Warn before closing the tab while `dirty`. */
export function useBeforeUnload(dirty) {
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return undefined;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}

const generatedTitle = (target) => {
  const role = target?.roleTitle || target?.title || "Generated Resume";
  const company = target?.companyName || target?.company_name || (typeof target?.company === "string" ? target.company : target?.company?.name);
  return company ? `${company} ${role}` : role;
};

/**
 * Auto-save every completed generator run to the Resume Bank (alumni sharing
 * depends on it). → { status: "idle"|"saving"|"saved"|"error", error, resume, retry }
 */
export function useGeneratorAutosave(workspace, targetJob) {
  const [save, setSave] = useState({ requestId: null, status: "idle", error: null, resume: null });
  const attempted = useRef(null);
  const latest = useRef({ workspace, targetJob });
  useEffect(() => {
    latest.current = { workspace, targetJob };
  });

  const run = useCallback(async (requestId) => {
    const { workspace: current, targetJob: target } = latest.current;
    const latexCode = current?.latexCode;
    if (!latexCode?.trim()) return;
    setSave({ requestId, status: "saving", error: null, resume: null });
    try {
      const resume = await saveGeneratedResume({ latexCode, title: generatedTitle(target), targetJob: target || null });
      setSave({ requestId, status: "saved", error: null, resume });
    } catch (error) {
      setSave({ requestId, status: "error", error, resume: null });
    }
  }, []);

  const requestId = workspace?.requestId ?? null;
  const complete = workspace?.status === "complete";
  useEffect(() => {
    if (!complete || !requestId || attempted.current === requestId) return;
    attempted.current = requestId;
    Promise.resolve().then(() => run(requestId));
  }, [complete, requestId, run]);

  const retry = useCallback(() => {
    if (requestId) run(requestId);
  }, [requestId, run]);

  const current = save.requestId === requestId ? save : { status: "idle", error: null, resume: null };
  return { status: current.status, error: current.error, resume: current.resume, retry };
}
