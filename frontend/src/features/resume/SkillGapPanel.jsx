import { useState } from "react";
import { ScanSearch, Sparkles } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, Panel, Tabs, useAsync } from "../../ui/index.js";
import { scoreResume } from "../../lib/api/resumes.js";
import AiAnalysisView from "./AiAnalysisView.jsx";
import JobPicker from "./JobPicker.jsx";
import ResumePicker from "./ResumePicker.jsx";
import { usePickerJobs } from "./hooks.js";
import { compareSkills, jobLabel, profileSkills } from "./labUtils.js";

const VIEWS = [
  { id: "compare", label: "Compare with a job" },
  { id: "ai", label: "AI gap analysis" },
];

function SkillList({ title, items, tone, empty }) {
  return (
    <div className={`border-2 border-black p-3 ${tone}`}>
      <h4 className="mb-2 text-[11px] font-black uppercase">
        {title} ({items.length})
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {items.length ? (
          items.map((item) => (
            <span key={item} className="badge-stark bg-white text-[10px]">
              {item}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-gray-500">{empty}</span>
        )}
      </div>
    </div>
  );
}

/**
 * `resume.lab` tab "skill-gap": the AI gap analysis when the agent produced one,
 * otherwise profile skills vs a picked campus / market job plus the resume's
 * keyword gap for that job (no hardcoded role lists).
 */
export default function SkillGapPanel({ params = {}, setParams, user, resumes = [], analysis, onNavigate }) {
  const [view, setView] = useState(() => (analysis ? "ai" : "compare"));
  const jobSource = params.jobSource === "market" ? "market" : "campus";
  const jobId = params.jobId ?? null;
  const resumeId = params.resumeId ?? null;
  const jobs = usePickerJobs(jobSource);
  const job = (jobs.data ?? []).find((item) => item.id === jobId) ?? null;
  const keywordGap = useAsync(() => scoreResume({ resumeId, jobId, jobSource }), [resumeId, jobId, jobSource], { enabled: Boolean(jobId) });

  const mySkills = profileSkills(user);
  const serverMatch = job && (job.matchedSkills.length || job.missingSkills.length);
  const skillGap = job ? (serverMatch ? { matched: job.matchedSkills, missing: job.missingSkills } : compareSkills(mySkills, job.skills)) : null;
  const keywords = keywordGap.data?.keywords;

  return (
    <Panel title="Skill gap analysis" icon={ScanSearch} badge={job ? jobLabel(job) : "CAREER FIT"}>
      {analysis && <Tabs tabs={VIEWS} value={view} onChange={setView} className="mb-3" label="Skill gap view" />}
      {analysis && view === "ai" ? (
        <AiAnalysisView analysis={analysis} />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <JobPicker
              source={jobSource}
              jobId={jobId}
              jobs={jobs.data ?? []}
              loading={jobs.loading}
              error={jobs.error}
              onReload={jobs.reload}
              label="Target job"
              onChange={({ jobSource: nextSource, jobId: nextJob }) => setParams?.({ jobSource: nextSource, jobId: nextJob })}
            />
            <ResumePicker resumes={resumes} value={resumeId} onChange={(id) => setParams?.({ resumeId: id })} placeholder="Primary resume" label="Resume (for keywords)" />
          </div>

          {!jobId ? (
            <EmptyState icon={ScanSearch} title="Pick a target job" text="Choose a campus drive or a job from the feed to compare it with your profile skills and resume." />
          ) : (
            <>
              <div>
                <h3 className="mb-2 text-xs font-black uppercase">Profile skills vs the job</h3>
                {!job ? (
                  jobs.loading ? <LoadingState label="LOADING JOB…" /> : <p className="text-[11px] text-gray-500">This job is not in the current list.</p>
                ) : job.skills.length === 0 && !serverMatch ? (
                  <p className="border-2 border-dashed border-gray-400 bg-gray-50 p-3 text-[11px] font-semibold text-gray-600">
                    This job doesn't list required skills. The resume keyword gap below is based on its description.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <SkillList title="Skills you already have" items={skillGap.matched} tone="bg-green-50" empty="No matching skills on your profile yet." />
                    <SkillList title="Skills to develop" items={skillGap.missing} tone="bg-yellow-50" empty="You cover every listed skill." />
                  </div>
                )}
                {mySkills.length === 0 && <p className="mt-2 text-[10px] font-semibold text-gray-500">Add skills to your profile for a more accurate comparison.</p>}
              </div>

              <div>
                <h3 className="mb-2 text-xs font-black uppercase">Resume keyword gap</h3>
                {keywordGap.loading ? (
                  <LoadingState label="CHECKING KEYWORDS…" />
                ) : keywordGap.error ? (
                  <ErrorState error={keywordGap.error} title="COULD NOT CHECK KEYWORDS" onRetry={keywordGap.reload} />
                ) : !keywordGap.data ? (
                  <p className="text-[11px] text-gray-500">Add a resume to your catalog to see which job keywords it is missing.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <SkillList title="Keywords in your resume" items={keywords?.matched ?? []} tone="bg-green-50" empty="None found yet." />
                    <SkillList title="Keywords missing" items={keywords?.missing ?? []} tone="bg-red-50" empty="Nothing missing." />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2 border-t-[1.5px] border-black pt-3">
                <button type="button" onClick={() => onNavigate?.({ tab: "tailor", resumeId, jobId, jobSource })} className="btn-primary px-3 py-1.5 text-xs">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> TAILOR RESUME FOR THIS JOB
                </button>
                <button type="button" onClick={() => onNavigate?.({ tab: "ats", resumeId, jobId, jobSource })} className="btn-secondary px-3 py-1.5 text-xs">
                  FULL ATS SCORE
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
