import { useDispatch, useSelector } from "react-redux";
import {
  BookOpen,
  Calendar,
  CheckCircle2,
  Compass,
  FileText,
  GraduationCap,
  Layers,
  Mic2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Target,
  TrendingUp,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { api } from "../lib/api.js";
import { runAIFeature, sendAIMessage } from "../services/aiRequestHandler.js";
import {
  resetLearningWorkspace,
  selectInterviewHistory,
  selectLearningWorkspace,
  setLearningSelectedInterview,
} from "../store/aiChatSlice.js";
import { setAgentMode } from "../store/appContextSlice.js";
import { formatDate } from "../ui/format.js";
import { useAsync } from "../ui/useAsync.js";
import { openPanel } from "../workspace/uiActions.js";
import { usePanel } from "../workspace/usePanel.js";

// Interview scores are 0–10 end to end (critic C2): "/10" with 8/6 thresholds is correct here.
// A value above 10 can only be an old 0–100 record, so it is rescaled.
const toTen = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(10, number > 10 ? number / 10 : number);
};
const scoreText = (value) => {
  const score = toTen(value);
  if (score === null) return "N/A";
  return `${Number.isInteger(score) ? score : score.toFixed(1)}/10`;
};
const scoreBadgeClass = (value) => {
  const score = toTen(value) ?? 0;
  if (score >= 8) return "bg-green-100 text-green-800 border-green-700";
  if (score >= 6) return "bg-yellow-100 text-yellow-800 border-yellow-700";
  return "bg-red-100 text-red-800 border-red-700";
};

const getFormatBadge = (format) => {
  const fmt = String(format || "").toLowerCase();
  if (fmt.includes("cheat")) return { label: "CHEAT-SHEET", bg: "bg-purple-100 text-purple-900 border-purple-700" };
  if (fmt.includes("guide") || fmt.includes("written")) return { label: "STUDY GUIDE", bg: "bg-blue-100 text-blue-900 border-blue-700" };
  if (fmt.includes("doc")) return { label: "DOCUMENTATION", bg: "bg-cyan-100 text-cyan-900 border-cyan-700" };
  if (fmt.includes("case")) return { label: "CASE STUDY", bg: "bg-amber-100 text-amber-900 border-amber-700" };
  return { label: "RESOURCE", bg: "bg-gray-100 text-gray-900 border-gray-700" };
};

const fromLocalHistory = (history) =>
  (history || []).map((entry) => ({
    _id: entry.id,
    role: entry.report?.meta?.role || "Mock interview",
    candidateName: entry.report?.meta?.candidate_name || "Candidate",
    overallScore: entry.report?.overall_score ?? null,
    generatedAt: entry.completedAt,
    skillGaps: entry.report?.skill_gaps || [],
    scores: entry.report?.scores || {},
    rawReport: entry.report,
  }));

const interviewId = (interview) => String(interview?._id ?? interview?.interviewId ?? "");

export default function LearningRecommendationWorkspace() {
  const dispatch = useDispatch();
  const learningWorkspace = useSelector(selectLearningWorkspace);
  const localInterviewHistory = useSelector(selectInterviewHistory);
  const { params } = usePanel("learning");

  // GET /interviews?limit=20 (legacy facade, full envelope); local history when the server is unreachable.
  const interviewsQuery = useAsync(async () => {
    const envelope = await api.getMyInterviews();
    const list = Array.isArray(envelope?.data) ? envelope.data : Array.isArray(envelope) ? envelope : [];
    return list;
  }, []);
  const usingLocal = Boolean(interviewsQuery.error) && localInterviewHistory.length > 0;
  const interviews = usingLocal ? fromLocalHistory(localInterviewHistory) : interviewsQuery.data ?? [];
  const preselectedId = params.interviewId ? String(params.interviewId) : null;
  const ordered = preselectedId
    ? [...interviews].sort((a, b) => Number(interviewId(b) === preselectedId) - Number(interviewId(a) === preselectedId))
    : interviews;

  const generateFor = (interview) => {
    dispatch(setLearningSelectedInterview(interview));
    dispatch(
      sendAIMessage({
        modeName: "learning-recommendation",
        feature: "learning-recommendation",
        source: "learning-workspace",
        text: `Generate personalized learning recommendations and improvement plan based on my ${interview.role || "mock"} interview performance.`,
        details: {
          selected_interview: interview.rawReport || interview,
          latest_interview: interview.rawReport || interview,
        },
      }),
    );
  };

  const practiceTopic = (topic) => {
    openPanel("interview");
    dispatch(setAgentMode("ai-interviewer"));
    dispatch(
      sendAIMessage({
        modeName: "ai-interviewer",
        feature: "mock-interview",
        source: "learning-workspace",
        text: `I want to practice an interview on ${topic}`,
      }),
    );
  };

  const chooseAnother = () => {
    dispatch(resetLearningWorkspace());
    interviewsQuery.reload();
  };

  const retry = () => {
    const selected = learningWorkspace.selectedInterview;
    if (selected) generateFor(selected);
    else chooseAnother();
  };

  const recommendations = learningWorkspace.recommendations;
  const isGenerating = learningWorkspace.status === "generating";
  const isError = learningWorkspace.status === "error";
  const hasReport = learningWorkspace.status === "complete" && Array.isArray(recommendations?.priorities);

  return (
    <div className="space-y-6">
      <div className="card-stark flex flex-col items-start justify-between gap-4 border-2 border-black bg-white p-5 md:flex-row md:items-center">
        <div className="flex items-center gap-3">
          <div className="border-2 border-black bg-black p-3 text-white shadow-bold-sm">
            <GraduationCap className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-black uppercase tracking-tight">AI learning roadmap</h2>
              <span className="badge-stark bg-purple-100 text-[10px] font-bold text-purple-900">POST-INTERVIEW COACH</span>
            </div>
            <p className="mt-0.5 text-xs font-semibold text-gray-600">
              Study guides, revision cheat-sheets and practice goals built from your mock interviews.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasReport || isError ? (
            <button type="button" onClick={chooseAnother} className="btn-secondary min-h-11 px-3 py-1.5 text-xs font-bold sm:min-h-0">
              <Compass className="h-4 w-4" aria-hidden="true" /> SELECT ANOTHER INTERVIEW
            </button>
          ) : (
            <button type="button" onClick={interviewsQuery.reload} disabled={interviewsQuery.loading} className="btn-secondary min-h-11 px-3 py-1.5 text-xs font-bold disabled:opacity-60 sm:min-h-0">
              <RefreshCw className={`h-3.5 w-3.5 ${interviewsQuery.loading ? "animate-spin" : ""}`} aria-hidden="true" /> REFRESH INTERVIEWS
            </button>
          )}
        </div>
      </div>

      {isGenerating && (
        <div className="card-stark space-y-4 border-2 border-black bg-white p-8 text-center" role="status">
          <div className="mx-auto flex h-12 w-12 items-center justify-center border-2 border-black bg-yellow-100">
            <Sparkles className="h-6 w-6 animate-spin" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase">Building your improvement plan…</h3>
            <p className="mx-auto mt-1 max-w-md text-xs text-gray-600">
              Reading your answers and scores to pick the gaps that matter most and the material to close them.
            </p>
          </div>
        </div>
      )}

      {isError && (
        <div role="alert" className="card-stark space-y-3 border-2 border-black bg-red-50 p-6 text-center">
          <TriangleAlert className="mx-auto h-7 w-7 text-red-700" aria-hidden="true" />
          <div className="text-xs font-black uppercase">Couldn&apos;t build the roadmap</div>
          <p className="mx-auto max-w-md text-[11px] font-semibold text-gray-700">
            {learningWorkspace.error || "The recommender didn't respond. Try again in a moment."}
          </p>
          <button type="button" onClick={retry} className="btn-primary min-h-11 px-4 py-1.5 text-xs sm:min-h-0">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> TRY AGAIN
          </button>
        </div>
      )}

      {hasReport && (
        <div className="space-y-6">
          <div className="card-stark space-y-3 border-2 border-black bg-yellow-50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-black pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge-stark bg-black text-xs font-black uppercase text-white">
                  TARGET ROLE: {recommendations.role || "Not specified"}
                </span>
                {toTen(recommendations.overall_score) !== null && (
                  <span className={`badge-stark border text-xs font-black ${scoreBadgeClass(recommendations.overall_score)}`}>
                    INTERVIEW SCORE: {scoreText(recommendations.overall_score)}
                  </span>
                )}
              </div>
              <div className="font-mono text-[11px] font-bold text-gray-500">GENERATED: {formatDate(recommendations.generated_at)}</div>
            </div>
            {recommendations.overview && <p className="text-xs font-medium leading-relaxed text-gray-800">{recommendations.overview}</p>}
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-tight">
                <Target className="h-4 w-4" aria-hidden="true" />
                <span>Key improvement priorities ({recommendations.priorities.length})</span>
              </h3>
              <span className="text-[11px] font-bold text-gray-600">Work through these in order</span>
            </div>

            {recommendations.priorities.length === 0 && (
              <div className="border-2 border-dashed border-gray-400 bg-gray-50 p-6 text-center text-xs font-bold">No priorities were returned for this interview.</div>
            )}

            <div className="grid grid-cols-1 gap-5">
              {recommendations.priorities.map((item, idx) => (
                <div key={idx} className="card-stark space-y-4 border-2 border-black bg-white p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b-[1.5px] border-black pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 items-center justify-center bg-black text-xs font-black text-white">#{idx + 1}</div>
                      <div>
                        <h4 className="text-sm font-black uppercase">{item.area}</h4>
                        <div className="text-[11px] font-bold text-gray-500">Priority focus area</div>
                      </div>
                    </div>
                    {toTen(item.current_score) !== null && (
                      <span className={`badge-stark border text-xs font-black ${scoreBadgeClass(item.current_score)}`}>
                        RECORDED SCORE: {scoreText(item.current_score)}
                      </span>
                    )}
                  </div>

                  {item.why && (
                    <div className="border border-black bg-gray-50 p-3 text-xs font-medium text-gray-800">
                      <span className="mb-1 block font-black uppercase text-black">Why this matters:</span>
                      {item.why}
                    </div>
                  )}

                  {Array.isArray(item.evidence) && item.evidence.length > 0 && (
                    <div className="space-y-1 border-l-4 border-amber-500 bg-amber-50 p-3">
                      <div className="flex items-center gap-1 text-[11px] font-black uppercase text-amber-950">
                        <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> Evidence from your interview:
                      </div>
                      <ul className="list-disc space-y-0.5 pl-4 text-xs font-medium text-amber-900">
                        {item.evidence.map((evidence, eIdx) => (
                          <li key={eIdx}>{evidence}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {Array.isArray(item.recommended_reading) && item.recommended_reading.length > 0 && (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center gap-1.5 text-xs font-black uppercase">
                        <BookOpen className="h-4 w-4" aria-hidden="true" /> Recommended reading & study guides:
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {item.recommended_reading.map((reading, rIdx) => {
                          const badge = getFormatBadge(reading.format);
                          return (
                            <div key={rIdx} className="flex flex-col justify-between space-y-2 border-[1.5px] border-black bg-white p-3.5 shadow-bold-sm">
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between gap-1">
                                  <span className={`badge-stark border text-[9px] font-black ${badge.bg}`}>{badge.label}</span>
                                  <FileText className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
                                </div>
                                <h5 className="line-clamp-2 text-xs font-black uppercase">{reading.title}</h5>
                                <p className="text-[11px] font-medium leading-snug text-gray-600">{reading.focus}</p>
                              </div>
                              {reading.reading_goal && (
                                <div className="border-t border-gray-200 bg-purple-50 p-2 text-[10px] font-bold text-purple-950">Goal: {reading.reading_goal}</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-3 border-t-[1.5px] border-black pt-2 md:grid-cols-2">
                    <div className="space-y-1 border border-blue-900/30 bg-blue-50 p-3">
                      <div className="flex items-center gap-1 text-[11px] font-black uppercase text-blue-950">
                        <Zap className="h-3.5 w-3.5 text-blue-700" aria-hidden="true" /> Practice task:
                      </div>
                      <p className="text-xs font-medium leading-relaxed text-blue-950">{item.practice_task || "—"}</p>
                    </div>
                    <div className="space-y-1 border border-green-900/30 bg-green-50 p-3">
                      <div className="flex items-center gap-1 text-[11px] font-black uppercase text-green-950">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-700" aria-hidden="true" /> Ready when:
                      </div>
                      <p className="text-xs font-medium leading-relaxed text-green-950">{item.success_criteria || "—"}</p>
                    </div>
                  </div>

                  {item.follow_up_interview_topic && (
                    <div className="flex justify-end pt-2">
                      <button type="button" onClick={() => practiceTopic(item.follow_up_interview_topic)} className="btn-primary min-h-11 px-3 py-1.5 text-xs font-bold shadow-bold-sm sm:min-h-0">
                        <Mic2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>TEST MYSELF ON &quot;{item.follow_up_interview_topic}&quot;</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!hasReport && !isGenerating && !isError && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-tight">
                <Layers className="h-4 w-4" aria-hidden="true" />
                <span>Your completed mock interviews</span>
              </h3>
              <p className="text-xs font-semibold text-gray-500">Pick an interview report to build reading material and a practice roadmap.</p>
            </div>
            <span className="badge-stark bg-black text-[10px] font-bold text-white">{interviews.length} FOUND</span>
          </div>

          {usingLocal && (
            <p className="border-2 border-black bg-yellow-50 p-2 text-[11px] font-bold">
              Showing interviews saved on this device — the server could not be reached.
            </p>
          )}

          {interviewsQuery.loading && interviews.length === 0 ? (
            <div className="card-stark space-y-3 border-2 border-black bg-white p-12 text-center" role="status">
              <RefreshCw className="mx-auto h-8 w-8 animate-spin" aria-hidden="true" />
              <div className="text-xs font-black uppercase">Loading your interviews…</div>
            </div>
          ) : interviewsQuery.error && !usingLocal ? (
            <div role="alert" className="border-2 border-black bg-red-50 p-6 text-center">
              <TriangleAlert className="mx-auto mb-2 h-7 w-7 text-red-700" aria-hidden="true" />
              <div className="text-xs font-black uppercase">Couldn&apos;t load your interviews</div>
              <p className="mt-1 text-[11px] font-semibold text-gray-700">{interviewsQuery.error?.message || "Please try again."}</p>
              <button type="button" onClick={interviewsQuery.reload} className="btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> TRY AGAIN
              </button>
            </div>
          ) : ordered.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {ordered.map((interview, index) => {
                const role = interview.role || interview.candidateName || "Mock interview";
                const overallScore = interview.overallScore ?? interview.rawReport?.overall_score;
                const skillGaps = interview.skillGaps || interview.rawReport?.skill_gaps || [];
                const techScore = interview.scores?.technical?.score ?? interview.rawReport?.scores?.technical?.score;
                const commScore = interview.scores?.communication?.score ?? interview.rawReport?.scores?.communication?.score;
                const highlighted = preselectedId && interviewId(interview) === preselectedId;

                return (
                  <div
                    key={interviewId(interview) || index}
                    className={`card-stark flex flex-col justify-between space-y-4 border-2 bg-white p-4 ${highlighted ? "border-black shadow-[4px_4px_0_0_#000] ring-2 ring-yellow-300" : "border-black"}`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2 border-b-[1.5px] border-black pb-2.5">
                        <div className="min-w-0">
                          <span className="badge-stark mb-1 bg-yellow-100 text-[10px] font-bold uppercase">
                            {interview.source === "job" ? "JOB DRIVE INTERVIEW" : "PROFILE INTERVIEW"}
                          </span>
                          {highlighted && <span className="badge-stark mb-1 ml-1 bg-black text-[10px] text-white">SELECTED</span>}
                          <h4 className="text-sm font-black uppercase leading-tight">{role}</h4>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-bold text-gray-500">
                            <Calendar className="h-3 w-3" aria-hidden="true" />
                            {formatDate(interview.generatedAt || interview.createdAt)}
                          </div>
                        </div>
                        <div className="text-right">
                          <span className={`badge-stark border text-xs font-black ${scoreBadgeClass(overallScore)}`}>{scoreText(overallScore)}</span>
                          <div className="mt-1 text-[9px] font-extrabold uppercase text-gray-500">Overall</div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs font-bold">
                        <div className="flex items-center justify-between border border-black bg-gray-50 p-2">
                          <span className="text-[10px] uppercase text-gray-600">Technical:</span>
                          <span className="font-black">{scoreText(techScore)}</span>
                        </div>
                        <div className="flex items-center justify-between border border-black bg-gray-50 p-2">
                          <span className="text-[10px] uppercase text-gray-600">Comm:</span>
                          <span className="font-black">{scoreText(commScore)}</span>
                        </div>
                      </div>

                      {Array.isArray(skillGaps) && skillGaps.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-extrabold uppercase text-gray-500">Identified skill gaps:</div>
                          <div className="flex flex-wrap gap-1">
                            {skillGaps.slice(0, 4).map((gap, gIdx) => (
                              <span key={gIdx} className="badge-stark border-red-300 bg-red-50 text-[10px] font-bold text-red-900">
                                {gap}
                              </span>
                            ))}
                            {skillGaps.length > 4 && (
                              <span className="badge-stark bg-gray-100 text-[10px] font-bold text-gray-700">+{skillGaps.length - 4} more</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <button type="button" onClick={() => generateFor(interview)} className="btn-primary min-h-11 w-full justify-center py-2 text-xs font-black shadow-bold-sm">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>GENERATE LEARNING ROADMAP</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="card-stark space-y-4 border-2 border-black bg-white p-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center border-2 border-black bg-gray-100">
                <BookOpen className="h-7 w-7 text-gray-700" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-black uppercase">No saved mock interviews yet</h4>
                <p className="mx-auto max-w-md text-xs text-gray-600">
                  Complete a mock interview with the AI interviewer to get scores, identified weaknesses and a tailored reading list.
                </p>
              </div>
              <button type="button" onClick={() => dispatch(runAIFeature("mock-interview"))} className="btn-primary min-h-11 px-4 py-2 text-xs font-black shadow-bold-sm">
                <Mic2 className="h-4 w-4" aria-hidden="true" />
                <span>TAKE A MOCK INTERVIEW NOW</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
