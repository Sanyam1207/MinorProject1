// header_message → sticky agent mode (FRONTEND.md §8.2). Every pre-existing
// entry is kept; the copilot headers are new. Pure module (node-tested).

export const AGENT_MODE_BY_HEADER = Object.freeze({
  // Copilot (tool-calling agent)
  "copilot:thinking": "copilot",
  "copilot:tool": "copilot",
  "copilot:answer": "copilot",
  "copilot:confirm": "copilot",
  "copilot:error": "copilot",
  "mode:switch:copilot": "copilot",
  // Jobs finder
  "mode:switch:jobs": "jobs-finder",
  "mode:jobparser:jobslist": "jobs-finder",
  // Resume generator
  "mode:switch:resume": "resume-generator",
  resume_generator: "resume-generator",
  "resume-generator": "resume-generator",
  // Eligibility
  "mode:switch:job-eligibility": "job-eligibility",
  "mode:jobparser:eligibility": "job-eligibility",
  // Job creation
  "mode:switch:job-creation": "job-creation",
  "mode:jobCreation:data": "job-creation",
  "mode:jobCreation:ready": "job-creation",
  "mode:jobCreation:post": "job-creation",
  "mode:jobCreation:error": "job-creation",
  // PR outreach
  "mode:switch:pr-outreach": "pr_outreach",
  "mail:review": "pr_outreach",
  pr_outreach_satisfied: "pr_outreach",
  pr_outreach_completed: "pr_outreach",
  // Alumni connect
  "mode:switch:alumni-connect": "alumni-connect",
  alumni_connect: "alumni-connect",
  "alumni:matches": "alumni-connect",
  "alumni:request-review": "alumni-connect",
  "alumni:resume-share-review": "alumni-connect",
  alumni_connect_completed: "alumni-connect",
  // AI interviewer
  "mode:switch:ai-interviewer": "ai-interviewer",
  "button:options": "ai-interviewer",
  "select:job:db": "ai-interviewer",
  "text:mode:interview": "ai-interviewer",
  "interview:end": "ai-interviewer",
  // Gap analysis
  "mode:switch:gap-analysis": "gap-analysis",
  "mode:gapAnalysis:analysis": "gap-analysis",
  "mode:gapAnalysis:suggestions": "gap-analysis",
  "mode:gapAnalysis:error": "gap-analysis",
  // Learning recommendation
  "mode:switch:learning-recommendation": "learning-recommendation",
  "select:interview:db": "learning-recommendation",
  "learning:recommendations": "learning-recommendation",
  "learning:recommendations-error": "learning-recommendation",
});

export const agentModeForHeader = (header) =>
  (typeof header === "string" && Object.hasOwn(AGENT_MODE_BY_HEADER, header) ? AGENT_MODE_BY_HEADER[header] : null);

/** After hydrating/opening a conversation: agent mode of the last bot message (so "Confirm" still reaches the copilot). */
export function agentModeForMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.sender === "bot") return agentModeForHeader(message.headerMessage);
  }
  return null;
}

export const isCopilotHeader = (header) => typeof header === "string" && header.startsWith("copilot:");

/** Terminal failure headers (FRONTEND.md §8.3 step 5). */
export const FAILURE_HEADERS = Object.freeze([
  "invalid request",
  "auth:required",
  "error",
  "AI backend unreachable",
  "AI backend timeout",
  "AI backend disconnected",
  "copilot:error",
]);

export const isFailureHeader = (header) => FAILURE_HEADERS.includes(header);
