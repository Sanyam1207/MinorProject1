import { useState } from "react";
import { Gauge, RotateCcw } from "lucide-react";
import { ErrorState, Panel, Tabs, useAsync } from "../../ui/index.js";
import { scoreResume } from "../../lib/api/resumes.js";
import ResumeScoreCard from "../../components/ResumeScoreCard.jsx";
import AiAnalysisView from "./AiAnalysisView.jsx";
import JobPicker from "./JobPicker.jsx";
import ResumePicker from "./ResumePicker.jsx";
import { usePickerJobs } from "./hooks.js";

const VIEWS = [
  { id: "score", label: "ATS score" },
  { id: "ai", label: "AI review" },
];

const seedMatches = (seed, resumeId, jobId) =>
  Boolean(seed) &&
  typeof seed === "object" &&
  Number.isFinite(seed.score) &&
  (!resumeId || String(seed.resume?._id ?? "") === resumeId) &&
  String(seed.target?.id ?? "") === String(jobId ?? "");

/**
 * `resume.lab` tab "ats": deterministic ATS score (8-part breakdown, keywords,
 * suggestions) for a resume, optionally against a job. A ScoreResult in the
 * copilot's ui `data` is shown without refetching. Keyed by the panel nonce.
 */
export default function AtsPanel({ params = {}, setParams, seed, resumes = [], analysis, onNavigate, onChanged }) {
  const resumeId = params.resumeId ?? null;
  const jobId = params.jobId ?? null;
  const jobSource = params.jobSource === "market" ? "market" : "campus";
  const [initialSeed] = useState(seed);
  const [view, setView] = useState(() => (analysis && !seedMatches(seed, resumeId, jobId) && !resumeId ? "ai" : "score"));
  const useSeed = seedMatches(initialSeed, resumeId, jobId);
  const jobs = usePickerJobs(jobSource);
  const score = useAsync(() => scoreResume({ resumeId, jobId, jobSource }), [resumeId, jobId, jobSource], { enabled: !useSeed });
  const result = useSeed ? initialSeed : score.data ?? null;
  const loading = !useSeed && score.loading;

  return (
    <Panel
      title="ATS score"
      icon={Gauge}
      badge="8-CHECK RUBRIC"
      actions={
        !useSeed && (
          <button type="button" onClick={score.reload} disabled={loading} className="btn-secondary min-h-9 px-2 py-1 text-[10px] disabled:opacity-40">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> RESCORE
          </button>
        )
      }
    >
      {analysis && <Tabs tabs={VIEWS} value={view} onChange={setView} className="mb-3" label="Score view" />}
      {analysis && view === "ai" ? (
        <AiAnalysisView analysis={analysis} />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <ResumePicker resumes={resumes} value={resumeId} onChange={(id) => setParams?.({ resumeId: id })} placeholder="Primary resume" />
            <JobPicker
              source={jobSource}
              jobId={jobId}
              jobs={jobs.data ?? []}
              loading={jobs.loading}
              error={jobs.error}
              onReload={jobs.reload}
              allowNone
              noneLabel="No job — general score"
              label="Score against (optional)"
              onChange={({ jobSource: nextSource, jobId: nextJob }) => setParams?.({ jobSource: nextSource, jobId: nextJob })}
            />
          </div>
          {score.error && !useSeed && score.error.code !== "NOT_FOUND" ? (
            <ErrorState error={score.error} title="COULD NOT SCORE THIS RESUME" onRetry={score.reload} />
          ) : (
            <ResumeScoreCard
              scoreData={result}
              loading={loading}
              jobId={jobId}
              jobSource={jobSource}
              embedded
              onResumeUploaded={(uploaded) => {
                onChanged?.();
                const uploadedId = uploaded?.resume?._id;
                if (uploadedId) setParams?.({ resumeId: String(uploadedId) });
              }}
            />
          )}
          {result && (
            <div className="flex flex-wrap gap-2 border-t-[1.5px] border-black pt-3">
              {result.resume?._id && (
                <button type="button" onClick={() => onNavigate?.({ tab: "editor", resumeId: String(result.resume._id) })} className="btn-secondary px-2 py-1 text-[10px]">
                  OPEN IN EDITOR
                </button>
              )}
              {result.resume?._id && jobId && (
                <button
                  type="button"
                  onClick={() => onNavigate?.({ tab: "tailor", resumeId: String(result.resume._id), jobId, jobSource })}
                  className="btn-primary px-2 py-1 text-[10px]"
                >
                  TAILOR FOR THIS JOB
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
