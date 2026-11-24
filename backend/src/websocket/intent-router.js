const ALUMNI_MODE = "alumni-connect";
const LEARNING_RECOMMENDATION_MODE = "learning-recommendation";

/**
 * Resolve high-confidence cross-agent intents before metadata is assembled.
 * This keeps a sticky UI mode (for example jobs-finder) from causing Node to
 * attach the wrong context to a request that clearly belongs to another agent.
 */
export const resolveIntentMode = ({ query, modeName } = {}) => {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const asksForImprovementPlan = (
        /\b(?:recommend(?:ation)?s?|suggest|plan|resources?|read|study|learn)\b/.test(normalizedQuery)
        && /\b(?:lack|lacks|gap|gaps|weak|weakness|improve|interview|mock|score|performance|latest)\b/.test(normalizedQuery)
    ) || /\bwhere\s+i\s+lack\b/.test(normalizedQuery);
    if (asksForImprovementPlan) return LEARNING_RECOMMENDATION_MODE;
    const hasShareAction = /\b(?:share|send)\b/.test(normalizedQuery);
    const hasResume = /\b(?:resume|cv)\b/.test(normalizedQuery);

    if (hasShareAction && hasResume) return ALUMNI_MODE;
    const hasAnalysisAction = /\b(?:score|rate|analy[sz]e|analysis|gap|compare|match)\b/.test(normalizedQuery);
    if (hasResume && hasAnalysisAction) return "resume-generator";
    const hasResumeAction = /\b(?:tailor|create|build|generate|make|edit|update|improve)\b/.test(normalizedQuery);
    if (hasResume && hasResumeAction) return "resume-generator";

    const hasGapAnalysis = /\b(?:gap\s+analysis|curriculum\s+gap|elective\s+suggest|skill\s+gap.*curriculum|curriculum.*skill\s+gap|analyse?\s+curriculum)\b/.test(normalizedQuery);
    if (hasGapAnalysis) return "gap-analysis";

    return modeName;
};
