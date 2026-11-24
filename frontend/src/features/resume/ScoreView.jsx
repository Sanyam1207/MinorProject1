import { AlertCircle, CheckCircle2, Target } from "lucide-react";
import { CHECK_STATUS_COLORS, scoreTone, scoreVerdict } from "./labUtils.js";

const RUBRIC = [
  ["skillsMatch", "Skills match & relevance"],
  ["projectDepth", "Project depth & technicality"],
  ["quantifiedImpact", "Quantified impact & metrics"],
  ["clarityAndFormatting", "Clarity & formatting"],
];

const KEYWORD_SOURCES = { job: "from the job", profile: "from your profile skills", breadth: "found across common technical skills" };

const clampPct = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function Bar({ percent, tone = "bg-black" }) {
  return (
    <div className="h-2.5 w-full border border-black bg-gray-100">
      <div className={`h-full ${tone}`} style={{ width: `${clampPct(percent)}%` }} />
    </div>
  );
}

/** Renders a deterministic ATS ScoreResult (RESUME-BYOK §5.3). */
export default function ScoreView({ result }) {
  if (!result) return null;
  const score = clampPct(result.score);
  const feedback = result.feedback || {};
  const rubric = feedback.rubricBreakdown || null;
  const breakdown = Array.isArray(result.breakdown) ? result.breakdown : [];
  const keywords = result.keywords || {};
  const matched = Array.isArray(keywords.matched) ? keywords.matched : [];
  const missing = Array.isArray(keywords.missing) ? keywords.missing : [];
  const strengths = Array.isArray(feedback.strengths) ? feedback.strengths : [];
  const improvements = Array.isArray(feedback.improvements) ? feedback.improvements : [];
  const stats = result.stats || {};
  const target = result.target;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
        <div className="flex flex-col items-center justify-center border-2 border-black bg-gray-50 p-4 text-center md:col-span-4">
          <div className="text-[10px] font-black uppercase text-gray-600">ATS score</div>
          <div className="my-1 text-5xl font-black tabular-nums tracking-tight">
            {score}
            <span className="text-xl font-bold text-gray-500">/100</span>
          </div>
          <div className="mb-2 w-full">
            <Bar percent={score} />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {result.grade && <span className={`badge-stark text-[10px] ${scoreTone(score)}`}>GRADE {result.grade}</span>}
            <span className="badge-stark text-[10px]">{scoreVerdict(score)}</span>
          </div>
          {result.resume?.title && <p className="mt-2 max-w-full truncate text-[10px] font-bold text-gray-600">{result.resume.title}</p>}
          {target && (
            <p className="mt-1 flex max-w-full items-center gap-1 truncate text-[10px] font-bold text-gray-600">
              <Target className="h-3 w-3 shrink-0" aria-hidden="true" />
              {target.title || "Selected job"}
              {target.company ? ` · ${target.company}` : ""}
            </p>
          )}
        </div>

        <div className="space-y-2.5 md:col-span-8">
          <div className="text-xs font-extrabold uppercase">Rubric</div>
          {rubric ? (
            RUBRIC.map(([key, label]) => (
              <div key={key}>
                <div className="mb-1 flex justify-between text-[11px] font-bold uppercase">
                  <span>{label}</span>
                  <span className="tabular-nums">{clampPct(rubric[key])}%</span>
                </div>
                <Bar percent={rubric[key]} />
              </div>
            ))
          ) : (
            <p className="text-[11px] text-gray-500">No rubric available for this score.</p>
          )}
        </div>
      </div>

      {breakdown.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-extrabold uppercase">Breakdown ({breakdown.length} checks)</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {breakdown.map((check) => (
              <div key={check.id || check.label} className="border-2 border-black bg-white p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-black uppercase">{check.label}</span>
                  <span className={`badge-stark shrink-0 text-[9px] uppercase ${CHECK_STATUS_COLORS[check.status] || "bg-gray-100"}`}>
                    {check.points}/{check.weight}
                  </span>
                </div>
                <div className="my-1.5">
                  <Bar percent={check.percent} tone={check.status === "fail" ? "bg-red-500" : check.status === "warn" ? "bg-yellow-400" : "bg-black"} />
                </div>
                {check.detail && <p className="text-[11px] font-medium text-gray-700">{check.detail}</p>}
                {check.suggestion && <p className="mt-1 text-[11px] font-bold">→ {check.suggestion}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(matched.length > 0 || missing.length > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="border-2 border-black bg-green-50 p-3">
            <div className="mb-2 text-[11px] font-black uppercase">
              Keywords matched ({matched.length}
              {Number.isFinite(keywords.total) ? `/${keywords.total}` : ""})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {matched.length ? (
                matched.map((item) => (
                  <span key={item} className="badge-stark bg-green-200 text-[10px]">
                    {item}
                  </span>
                ))
              ) : (
                <span className="text-[11px] text-gray-500">None yet.</span>
              )}
            </div>
          </div>
          <div className="border-2 border-black bg-yellow-50 p-3">
            <div className="mb-2 text-[11px] font-black uppercase">Keywords missing ({missing.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {missing.length ? (
                missing.map((item) => (
                  <span key={item} className="badge-stark bg-yellow-200 text-[10px]">
                    {item}
                  </span>
                ))
              ) : (
                <span className="text-[11px] text-gray-500">Nothing missing.</span>
              )}
            </div>
          </div>
          {(keywords.source || keywords.note) && (
            <p className="text-[10px] font-semibold text-gray-500 sm:col-span-2">
              {keywords.source ? `Keywords ${KEYWORD_SOURCES[keywords.source] || keywords.source}.` : ""} {keywords.note || ""}
            </p>
          )}
        </div>
      )}

      {(strengths.length > 0 || improvements.length > 0) && (
        <div className="grid grid-cols-1 gap-4 border-t-2 border-black pt-4 md:grid-cols-2">
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Key strengths
            </h4>
            <ul className="space-y-1 text-xs font-medium">
              {strengths.length ? strengths.map((item) => <li key={item}>• {item}</li>) : <li className="text-gray-500">Keep improving — strengths appear above 80%.</li>}
            </ul>
          </div>
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase">
              <AlertCircle className="h-4 w-4" aria-hidden="true" /> Suggested improvements
            </h4>
            <ul className="space-y-1 text-xs font-medium">
              {improvements.length ? improvements.map((item) => <li key={item}>• {item}</li>) : <li className="text-gray-500">No major fixes needed.</li>}
            </ul>
          </div>
        </div>
      )}

      {Number.isFinite(stats.words) && (
        <div className="flex flex-wrap gap-1.5 border-t-[1.5px] border-black pt-3 text-[10px] font-bold uppercase">
          <span className="badge-stark tabular-nums">{stats.words} words</span>
          {Number.isFinite(stats.pages) && <span className="badge-stark tabular-nums">{stats.pages} page(s)</span>}
          {Number.isFinite(stats.bullets) && <span className="badge-stark tabular-nums">{stats.bullets} bullets</span>}
          {Number.isFinite(stats.quantifiedBullets) && <span className="badge-stark tabular-nums">{stats.quantifiedBullets} quantified</span>}
          {Number.isFinite(stats.actionVerbBullets) && <span className="badge-stark tabular-nums">{stats.actionVerbBullets} action verbs</span>}
          {stats.weakPhraseBullets > 0 && <span className="badge-stark bg-yellow-100 tabular-nums">{stats.weakPhraseBullets} weak phrases</span>}
        </div>
      )}
    </div>
  );
}
