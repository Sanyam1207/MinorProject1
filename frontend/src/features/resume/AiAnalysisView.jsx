const SCORE_LABELS = {
  ats_structure: "ATS structure",
  keyword_coverage: "Keyword coverage",
  experience_relevance: "Experience relevance",
  project_relevance: "Project relevance",
};

/** AI analysis from the resume-generator agent (`resumeWorkspace.analysis`, type "score" or "gap"). */
export default function AiAnalysisView({ analysis }) {
  if (!analysis) return null;
  const target = analysis.target_job;
  const gaps = [
    ...(analysis.resume_gaps || []).map((item) => ({ ...item, kind: "Resume gap", color: "bg-yellow-50" })),
    ...(analysis.profile_gaps || []).map((item) => ({ ...item, kind: "Profile gap", color: "bg-red-50" })),
  ];
  const overall = Number(analysis.overall_score);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-black pb-4">
        <div className="min-w-0">
          <span className="badge-stark bg-purple-100 text-[10px]">{analysis.analysis_type === "gap" ? "AI JOB GAP ANALYSIS" : "AI RESUME REVIEW"}</span>
          <h2 className="mt-2 truncate text-base font-black uppercase">{analysis.resume?.title || "Current resume"}</h2>
          {target && (
            <p className="text-xs font-bold text-gray-600">
              Against {target.title || "selected role"}
              {target.company ? ` at ${target.company}` : ""}
            </p>
          )}
        </div>
        {Number.isFinite(overall) && (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center border-4 border-black bg-green-100 text-2xl font-black tabular-nums">
            {overall}
            <span className="text-xs">/100</span>
          </div>
        )}
      </div>

      {analysis.summary && <p className="text-xs font-semibold text-gray-700">{analysis.summary}</p>}

      {analysis.subscores && Object.keys(analysis.subscores).length > 0 && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {Object.entries(analysis.subscores).map(([key, value]) => (
            <div key={key} className="border-2 border-black bg-gray-50 p-3">
              <div className="text-[10px] font-black uppercase text-gray-500">{SCORE_LABELS[key] || key.replaceAll("_", " ")}</div>
              <div className="mt-1 text-xl font-black tabular-nums">{value}/100</div>
            </div>
          ))}
        </div>
      )}

      {(analysis.matched_requirements || []).length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-black uppercase">Supported matches</h3>
          <div className="space-y-2">
            {analysis.matched_requirements.map((item, index) => (
              <div key={`${item.requirement}-${index}`} className="border-2 border-black bg-green-50 p-3 text-xs">
                <div className="font-black uppercase">{item.requirement}</div>
                <div className="mt-1 text-gray-700">{item.evidence}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {gaps.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-black uppercase">Gaps and actions</h3>
          <div className="space-y-2">
            {gaps.map((item, index) => (
              <div key={`${item.kind}-${item.requirement}-${index}`} className={`border-2 border-black p-3 text-xs ${item.color}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-black uppercase">{item.requirement}</span>
                  <span className="badge-stark bg-white text-[9px]">{item.kind}</span>
                </div>
                {item.issue && <p className="mt-1 text-gray-700">{item.issue}</p>}
                {item.recommendation && <p className="mt-2 font-bold">Action: {item.recommendation}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(analysis.recommendations || []).length > 0 && (
        <div className="border-2 border-black bg-blue-50 p-3">
          <h3 className="mb-2 text-xs font-black uppercase">Recommended improvements</h3>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {analysis.recommendations.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
