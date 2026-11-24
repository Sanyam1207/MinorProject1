// AI features started from tiles/buttons (FRONTEND.md §8.3 runFeature).
// Each opens its panel through applyUiActions (role-checked) and sends the
// default prompt with a sticky agent mode.
const AI_FEATURES = Object.freeze({
  drives: {
    id: "drives",
    panel: "jobs.matched",
    roles: ["student"],
    agentMode: "jobs-finder",
    defaultPrompt: "Can you help me find some Jobs",
  },
  "resume-generator": {
    id: "resume-generator",
    panel: "resume.lab",
    params: { tab: "generator" },
    roles: ["student"],
    agentMode: "resume-generator",
    defaultPrompt: "Help me build my resume from my profile",
  },
  "mock-interview": {
    id: "mock-interview",
    panel: "interview",
    roles: ["student"],
    agentMode: "ai-interviewer",
    defaultPrompt: "Start a mock interview",
  },
  "job-creation": {
    id: "job-creation",
    panel: "tpo.job-creator",
    roles: ["tpo", "admin"],
    agentMode: "job-creation",
    defaultPrompt: "Help me create a new placement job",
  },
  "gap-analysis": {
    id: "gap-analysis",
    panel: "tpo.gap-analysis",
    roles: ["tpo", "admin"],
    agentMode: "gap-analysis",
    defaultPrompt: "Perform a gap analysis between our current curriculum and industry-demanded skills",
  },
});

export const getAIFeature = (featureId) => AI_FEATURES[featureId] || null;

export default AI_FEATURES;
