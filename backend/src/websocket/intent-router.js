const ALUMNI_MODE = "alumni-connect";
const LEARNING_RECOMMENDATION_MODE = "learning-recommendation";
const RESUME_MODE = "resume-generator";
const GAP_ANALYSIS_MODE = "gap-analysis";

// Which suggested modes each role may be sent to. Anything not listed is left
// to the Python orchestrator (whose copilot handles teachers, recruiters, etc.).
const MODES_BY_ROLE = {
    student: new Set([LEARNING_RECOMMENDATION_MODE, ALUMNI_MODE, RESUME_MODE]),
    tpo: new Set([GAP_ANALYSIS_MODE]),
    admin: new Set([GAP_ANALYSIS_MODE]),
};

const suggestMode = (normalizedQuery) => {
    const asksForImprovementPlan = (
        /\b(?:recommend(?:ation)?s?|suggest|plan|resources?|read|study|learn)\b/.test(normalizedQuery)
        && /\b(?:lack|lacks|gap|gaps|weak|weakness|improve|interview|mock|score|performance|latest)\b/.test(normalizedQuery)
        && !/\b(?:class|classes|lecture|attendance|course)\b/.test(normalizedQuery)
    ) || /\bwhere\s+i\s+lack\b/.test(normalizedQuery);
    if (asksForImprovementPlan) return LEARNING_RECOMMENDATION_MODE;

    const hasResume = /\b(?:resume|cv)\b/.test(normalizedQuery);
    const sharesWithAlumni = /\b(?:share|send)\b/.test(normalizedQuery)
        && /\b(?:alumni|alumnus|mentor|mentors|senior|seniors|connection|connections)\b/.test(normalizedQuery);
    if (hasResume && sharesWithAlumni) return ALUMNI_MODE;

    const hasAnalysisAction = /\b(?:score|rate|analy[sz]e|analysis|gap|compare|match)\b/.test(normalizedQuery);
    if (hasResume && hasAnalysisAction) return RESUME_MODE;
    const hasResumeAction = /\b(?:tailor|create|build|generate|make|edit|update|improve)\b/.test(normalizedQuery);
    if (hasResume && hasResumeAction) return RESUME_MODE;

    const hasGapAnalysis = /\b(?:gap\s+analysis|curriculum\s+gap|elective\s+suggest|skill\s+gap.*curriculum|curriculum.*skill\s+gap|analyse?\s+curriculum)\b/.test(normalizedQuery);
    if (hasGapAnalysis) return GAP_ANALYSIS_MODE;

    return null;
};

/**
 * Suggest a specialised agent for a chat turn from high-confidence phrasing.
 *
 * Only suggestions the user's role may use are returned; otherwise the
 * current `modeName` is returned unchanged and the Python orchestrator (which
 * has the copilot fallback and stricter switch rules) decides. The caller
 * applies the suggestion only to turns without an active mode.
 */
export const resolveIntentMode = ({ query, modeName, role } = {}) => {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const suggestion = suggestMode(normalizedQuery);
    if (!suggestion) return modeName;
    const allowed = MODES_BY_ROLE[role] || null;
    if (!allowed || !allowed.has(suggestion)) return modeName;
    return suggestion;
};
