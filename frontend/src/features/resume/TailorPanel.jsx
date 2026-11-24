import { useState } from "react";
import { ClipboardPaste, FilePlus2, LoaderCircle, Save, Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import { EmptyState, toastError, toastInfo, toastSuccess, useAsync } from "../../ui/index.js";
import { errorMessage } from "../../lib/http.js";
import { applyResumePatches, getResume } from "../../lib/api/resumes.js";
import { JD_MAX_CHARS, JD_MIN_CHARS, getJobDescription, saveJobDescription, tailorResume } from "../../lib/api/llm.js";
import { useLlmCredentials, usePickerJobs } from "./hooks.js";
import CredentialPicker from "./CredentialPicker.jsx";
import JobPicker from "./JobPicker.jsx";
import PatchReviewList from "./PatchReviewList.jsx";
import ResumePicker from "./ResumePicker.jsx";
import { jobKey, jobLabel } from "./labUtils.js";
import { normalizePatches, patchStates, skipReasonLabel } from "./patches.js";

const LLM_ERROR_HINTS = {
  BYOK_DISABLED: "AI keys are not configured on this server, so tailoring is unavailable.",
  LLM_KEY_REQUIRED: "Add an AI key first (AI KEYS).",
  LLM_KEY_INVALID: "The provider rejected this key. Update or remove it in AI KEYS.",
  LLM_MODEL_NOT_FOUND: "That model isn't available for this key. Pick another model.",
  LLM_REFUSED: "The model declined this request. Try again or pick another model.",
  LLM_TRUNCATED: "The model's answer was cut off. Try again, or pick a model with a larger output limit.",
  LLM_BAD_JSON: "The model returned an unreadable answer. Try again or pick another model.",
  LLM_RATE_LIMITED: "The provider is rate-limiting this key. Wait a minute and try again.",
  LLM_TIMEOUT: "The model took too long. Try again.",
  TOO_MANY_ATTEMPTS: "You've reached the hourly tailoring limit. Try again later.",
  UNREADABLE_FILE: "No text could be read from this resume, so it can't be tailored.",
};

const describeError = (error) => LLM_ERROR_HINTS[error?.code] || errorMessage(error, "Tailoring failed. Please try again.");

const initialDecisions = (patches) => Object.fromEntries(patches.map((patch) => [patch.id, "accept"]));

/** A tailoring result (from POST /llm/tailor or the copilot's ui `data`) for one resume + job. */
const toResult = (raw, fallback) => {
  const patches = normalizePatches(raw?.patches);
  return {
    key: `${raw?.resumeId || fallback.resumeId}|${jobKey(raw?.jobSource || fallback.jobSource, raw?.jobId || fallback.jobId)}`,
    patches,
    skipped: Array.isArray(raw?.skipped) ? raw.skipped : [],
    missingKeywordsFound: Array.isArray(raw?.missingKeywordsFound) ? raw.missingKeywordsFound : [],
    appliesTo: raw?.appliesTo || "source",
    sourceHash: raw?.sourceHash || null,
    provider: raw?.provider || null,
    model: raw?.model || null,
    job: raw?.job || null,
    decisions: initialDecisions(patches),
  };
};

const seedPatches = (seed) => Boolean(seed) && typeof seed === "object" && (Array.isArray(seed.patches) || seed.requiresManualJD);

/**
 * `resume.lab` tab "tailor" (full-height). Selection lives in the panel params
 * (resumeId, jobId, jobSource, credentialId) so the copilot and other tabs share it.
 * Patches from the copilot's ui `data` are used directly (no second LLM call).
 * Pasted job descriptions are kept per job key and never reused for another job.
 */
export default function TailorPanel({ params = {}, setParams, seed, resumes = [], primaryId, onNavigate, onOpenKeys, onChanged }) {
  const keys = useLlmCredentials();
  const jobSource = params.jobSource === "market" ? "market" : "campus";
  const jobId = params.jobId ?? null;
  const resumeId = params.resumeId ?? primaryId ?? null;
  const credentialId = params.credentialId ?? keys.credentials[0]?.id ?? null;
  const credential = keys.credentials.find((item) => item.id === credentialId) ?? null;
  const currentJobKey = jobKey(jobSource, jobId);
  const resultKey = `${resumeId}|${currentJobKey}`;

  const jobs = usePickerJobs(jobSource);
  const job = (jobs.data ?? []).find((item) => item.id === jobId) ?? null;

  const [models, setModels] = useState({});
  const model = (credentialId && models[credentialId]) || credential?.model || "";
  const [jdDrafts, setJdDrafts] = useState({});
  const [jdOpen, setJdOpen] = useState({});
  const [jdMessage, setJdMessage] = useState({});
  const [result, setResult] = useState(() => (seedPatches(seed) && Array.isArray(seed.patches) ? toResult(seed, { resumeId, jobId, jobSource }) : null));
  const [seenSeed, setSeenSeed] = useState(seed);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [applying, setApplying] = useState(null);
  const [newTitle, setNewTitle] = useState("");
  const [makePrimary, setMakePrimary] = useState(false);
  const [applyReport, setApplyReport] = useState(null);

  // A new copilot result (ui `data`) replaces the review list — adjusted during render.
  if (seed !== seenSeed) {
    setSeenSeed(seed);
    if (seedPatches(seed)) {
      const seedJobKey = jobKey(seed.jobSource || jobSource, seed.jobId || jobId);
      if (seed.requiresManualJD) {
        setJdOpen((previous) => ({ ...previous, [seedJobKey]: true }));
        if (seed.message) setJdMessage((previous) => ({ ...previous, [seedJobKey]: seed.message }));
      } else {
        setResult(toResult(seed, { resumeId, jobId, jobSource }));
        setApplyReport(null);
        setRunError(null);
      }
    }
  }

  const resume = resumes.find((item) => item.id === resumeId) ?? null;
  const resumeContent = useAsync(() => getResume(resumeId), [resumeId], { enabled: Boolean(resumeId) });
  const content = resumeContent.data?.contentKind === "extracted" ? "" : resumeContent.data?.content ?? "";

  const showJd = Boolean(jdOpen[currentJobKey]);
  const savedJd = useAsync(() => getJobDescription(jobSource, jobId), [jobSource, jobId], { enabled: Boolean(jobId) && showJd });
  const jdText = jdDrafts[currentJobKey] ?? savedJd.data?.text ?? "";

  const visible = result && result.key === resultKey ? result : null;
  const states = visible && visible.appliesTo === "source" ? patchStates(content, visible.patches) : {};
  const acceptedPatches = visible ? visible.patches.filter((patch) => visible.decisions[patch.id] !== "reject") : [];
  const suggestionsOnly = visible?.appliesTo === "extracted_text" || (resume && !["latex", "text"].includes(resume.kind));

  const pick = (patch) => {
    setParams?.(patch);
    setApplyReport(null);
    setRunError(null);
  };

  const setDecision = (id, decision) =>
    setResult((previous) => (previous ? { ...previous, decisions: { ...previous.decisions, [id]: decision } } : previous));
  const setAllDecisions = (decision) =>
    setResult((previous) => (previous ? { ...previous, decisions: Object.fromEntries(previous.patches.map((patch) => [patch.id, decision])) } : previous));

  const run = async () => {
    setRunError(null);
    setApplyReport(null);
    if (!resumeId) return setRunError({ message: "Pick a resume to tailor." });
    if (!jobId) return setRunError({ message: "Pick a job to tailor this resume for." });
    if (!credential) return setRunError({ message: "Choose a saved AI key (or add one in AI KEYS)." });
    const key = currentJobKey;
    const manual = showJd ? jdText.trim() : "";
    if (showJd && manual && (manual.length < JD_MIN_CHARS || manual.length > JD_MAX_CHARS)) {
      return setRunError({ message: `Paste the full job description (${JD_MIN_CHARS}–${JD_MAX_CHARS.toLocaleString("en-IN")} characters).` });
    }
    setRunning(true);
    try {
      if (manual) await saveJobDescription(jobSource, jobId, manual);
      const response = await tailorResume({
        resumeId,
        jobId,
        jobSource,
        credentialId: credential.id,
        provider: credential.provider,
        model: model || undefined,
        manualJobDescription: manual || undefined,
      });
      if (response.requiresManualJD) {
        setJdOpen((previous) => ({ ...previous, [key]: true }));
        setJdMessage((previous) => ({ ...previous, [key]: response.message }));
        toastInfo("Paste the job description to continue");
        return undefined;
      }
      setResult(toResult(response, { resumeId, jobId, jobSource }));
      if (response.totalPatches) toastSuccess(`${response.totalPatches} suggestion(s) ready — nothing has been changed yet`);
      else toastInfo("No safe edits found — your resume already covers this job");
    } catch (error) {
      setRunError(error);
      if (error?.code === "LLM_KEY_INVALID") keys.reload();
    } finally {
      setRunning(false);
    }
    return undefined;
  };

  const apply = async (mode) => {
    if (!visible || !acceptedPatches.length) return;
    setApplying(mode);
    setApplyReport(null);
    try {
      const outcome = await applyResumePatches(resumeId, {
        patches: acceptedPatches,
        mode,
        baseSourceHash: visible.sourceHash || undefined,
        title: mode === "new-version" && newTitle.trim() ? newTitle.trim() : undefined,
        makePrimary: mode === "new-version" ? makePrimary : undefined,
        targetJob: job ? { source: job.source, id: job.id, title: job.title, company: job.company } : visible.job || undefined,
      });
      setApplyReport({ applied: outcome.applied, skipped: outcome.skipped });
      toastSuccess(
        `${outcome.applied.length} suggestion(s) applied${outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ""}${mode === "new-version" ? " as a new version" : ""}`,
      );
      onChanged?.();
      resumeContent.reload();
      if (outcome.resume?.id) onNavigate?.({ tab: "editor", resumeId: outcome.resume.id, jobId, jobSource });
    } catch (error) {
      if (error?.code === "NO_PATCHES_APPLIED") setApplyReport({ applied: [], skipped: error.details?.skipped || [] });
      toastError(error, "Could not apply the suggestions");
    } finally {
      setApplying(null);
    }
  };

  if (keys.disabled) {
    return (
      <div className="card-stark bg-white">
        <EmptyState icon={Sparkles} title="AI tailoring is unavailable" text="AI keys (BYOK) are not configured on this server. Ask your administrator to enable them." />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-black bg-white">
      <div className="shrink-0 space-y-2.5 border-b-2 border-black p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" aria-hidden="true" />
            <h3 className="text-sm font-black uppercase">AI tailor</h3>
          </div>
          <span className="badge-stark bg-purple-100 text-[10px]">YOUR KEY · SURGICAL EDITS</span>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <ResumePicker resumes={resumes} value={resumeId} onChange={(id) => pick({ resumeId: id })} />
          <JobPicker
            source={jobSource}
            jobId={jobId}
            jobs={jobs.data ?? []}
            loading={jobs.loading}
            error={jobs.error}
            onReload={jobs.reload}
            onChange={({ jobSource: nextSource, jobId: nextJob }) => pick({ jobSource: nextSource, jobId: nextJob })}
          />
        </div>
        <CredentialPicker
          credentials={keys.credentials}
          credentialId={credentialId}
          loading={keys.loading}
          onCredentialChange={(id) => pick({ credentialId: id })}
          model={model}
          onModelChange={(next) => credentialId && setModels((previous) => ({ ...previous, [credentialId]: next }))}
          onManageKeys={onOpenKeys}
        />
        {keys.error && <p className="text-[11px] font-bold text-red-700">{errorMessage(keys.error, "Could not load your AI keys")}</p>}

        {jobId && (
          <div className="border-2 border-black bg-gray-50 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[10px] font-black uppercase">Job description · {job ? jobLabel(job) : "selected job"}</span>
              {!showJd && (
                <button type="button" onClick={() => setJdOpen((previous) => ({ ...previous, [currentJobKey]: true }))} className="btn-secondary px-2 py-1 text-[10px]">
                  <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" /> PASTE JD MANUALLY
                </button>
              )}
            </div>
            {showJd ? (
              <div className="mt-2 space-y-1.5">
                {jdMessage[currentJobKey] && <p className="text-[11px] font-bold">{jdMessage[currentJobKey]}</p>}
                {savedJd.data?.textSource === "saved" && jdDrafts[currentJobKey] === undefined && (
                  <p className="text-[10px] font-semibold text-gray-600">Using the description you saved for this job.</p>
                )}
                <textarea
                  value={jdText}
                  onChange={(event) => setJdDrafts((previous) => ({ ...previous, [currentJobKey]: event.target.value }))}
                  rows={6}
                  maxLength={JD_MAX_CHARS}
                  placeholder={savedJd.loading ? "Loading saved description…" : "Copy and paste the full job description here…"}
                  aria-label="Job description"
                  className="input-stark w-full resize-y text-base sm:text-xs"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-semibold text-gray-500">
                  <span className="tabular-nums">
                    {jdText.trim().length.toLocaleString("en-IN")} / {JD_MAX_CHARS.toLocaleString("en-IN")} chars · saved only for this job, only for you
                  </span>
                  <button
                    type="button"
                    disabled={jdText.trim().length < JD_MIN_CHARS}
                    onClick={() =>
                      saveJobDescription(jobSource, jobId, jdText.trim())
                        .then(() => toastSuccess("Job description saved for this job"))
                        .catch((error) => toastError(error, "Could not save the job description"))
                    }
                    className="btn-secondary px-2 py-1 text-[10px] disabled:opacity-40"
                  >
                    <Save className="h-3.5 w-3.5" aria-hidden="true" /> SAVE JD
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-[10px] font-semibold text-gray-600">The job's own description is used. If it's missing you'll be asked to paste it.</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={run} disabled={running || !credential || !resumeId || !jobId} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
            {running ? "REVIEWING…" : visible ? "RUN AGAIN" : "SUGGEST EDITS"}
          </button>
          <span className="text-[10px] font-semibold text-gray-500">Suggestions never change your resume until you apply them.</span>
        </div>
        {runError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-2 border-black bg-red-50 p-2 text-[11px] font-bold text-red-900">
            <span className="flex items-center gap-1.5">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {runError.code ? describeError(runError) : runError.message}
            </span>
            {["LLM_KEY_INVALID", "LLM_KEY_REQUIRED"].includes(runError.code) && onOpenKeys && (
              <button type="button" onClick={onOpenKeys} className="btn-secondary px-2 py-1 text-[10px]">
                OPEN AI KEYS
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!visible ? (
          <EmptyState
            icon={Sparkles}
            title={running ? "Reviewing your resume…" : "No suggestions yet"}
            text="Pick a resume, a job and one of your AI keys, then ask for surgical keyword edits. You review every change before anything is saved."
          />
        ) : visible.patches.length === 0 ? (
          <EmptyState icon={Sparkles} title="No safe edits found" text="Your resume already covers this job's key requirements, or every suggestion failed validation." />
        ) : (
          <div className="space-y-3">
            {visible.missingKeywordsFound.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-black uppercase">Missing keywords:</span>
                {visible.missingKeywordsFound.map((keyword) => (
                  <span key={keyword} className="badge-stark bg-yellow-200 text-[9px]">
                    {keyword}
                  </span>
                ))}
              </div>
            )}
            {(visible.provider || visible.model) && (
              <p className="font-mono text-[10px] text-gray-500">
                {visible.provider} · {visible.model}
                {visible.skipped.length ? ` · ${visible.skipped.length} invalid suggestion(s) dropped` : ""}
              </p>
            )}
            {suggestionsOnly && (
              <p className="border-2 border-black bg-blue-50 p-2 text-[11px] font-bold">
                Suggestions only — this resume is a {resume ? resume.kind.toUpperCase() : "file"}, so edits can't be applied automatically. Copy the ones you like into your document.
              </p>
            )}
            <PatchReviewList
              patches={visible.patches}
              decisions={visible.decisions}
              states={states}
              onDecide={setDecision}
              onDecideAll={setAllDecisions}
              readOnly={suggestionsOnly}
            />
          </div>
        )}
      </div>

      {visible && visible.patches.length > 0 && !suggestionsOnly && (
        <div className="shrink-0 space-y-2 border-t-2 border-black bg-gray-50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {applyReport && applyReport.skipped.length > 0 && (
            <ul className="space-y-0.5 text-[10px] font-semibold text-orange-900">
              {applyReport.skipped.map((item) => (
                <li key={`${item.id}-${item.reason}`}>
                  Skipped {item.id}: {skipReasonLabel(item.reason)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-0 flex-1 sm:max-w-xs">
              <span className="mb-1 block text-[10px] font-black uppercase">New version title (optional)</span>
              <input
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                maxLength={200}
                placeholder={resume ? `${resume.title} – ${job?.company || job?.title || "tailored"}` : "Tailored resume"}
                className="input-stark w-full text-base sm:text-xs"
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase">
              <input type="checkbox" checked={makePrimary} onChange={(event) => setMakePrimary(event.target.checked)} className="h-4 w-4 accent-black" />
              Make primary
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => apply("new-version")}
              disabled={Boolean(applying) || !acceptedPatches.length}
              className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0"
            >
              {applying === "new-version" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />}
              APPLY {acceptedPatches.length} AS NEW VERSION
            </button>
            <button
              type="button"
              onClick={() => apply("in-place")}
              disabled={Boolean(applying) || !acceptedPatches.length || resume?.locked}
              title={resume?.locked ? "This resume is locked — apply as a new version" : undefined}
              className="btn-secondary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0"
            >
              {applying === "in-place" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
              OVERWRITE THIS RESUME
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
