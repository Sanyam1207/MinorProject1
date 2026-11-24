// Legacy agent headers → UI actions (UI-ACTIONS.md §8). Pure module.
//
// The returned actions are applied by aiRequestHandler with `source: "header"`
// and therefore role-checked like any other action — a TPO receiving a
// jobs-finder answer stays in TPO mode (no alias → FORBIDDEN → skipped).
// Each action id is `hdr:<requestId>:<panel>:<params.tab or ''>`, so streaming
// chunks of the same request open a panel only once.
import { isCopilotHeader } from "./agentModes.js";

const PR_OUTREACH = new Set(["mode:switch:pr-outreach", "mail:review", "pr_outreach_satisfied"]);
const ALUMNI = new Set(["mode:switch:alumni-connect", "alumni:matches", "alumni:request-review", "alumni:resume-share-review"]);
const INTERVIEW = new Set(["mode:switch:ai-interviewer", "button:options", "select:job:db", "text:mode:interview", "interview:end"]);
const GAP_ANALYSIS = new Set(["mode:switch:gap-analysis", "mode:gapAnalysis:analysis", "mode:gapAnalysis:suggestions", "mode:gapAnalysis:error"]);
const LEARNING = new Set(["mode:switch:learning-recommendation", "select:interview:db", "learning:recommendations", "learning:recommendations-error"]);
const JOB_CREATION = new Set(["mode:jobCreation:data", "mode:jobCreation:ready", "mode:jobCreation:post", "mode:jobCreation:error"]);

function headerActions(header, data) {
  if (header === "mode:jobparser:jobslist") return Array.isArray(data) && data.length > 0 ? [{ panel: "jobs.matched" }] : [];
  if (header === "mode:jobparser:eligibility") return [{ panel: "jobs.campus" }];
  if (header === "mode:jobparser:addjob:wishlist") {
    return data?.type === "wishlist" && data.ui && typeof data.ui === "object" && !Array.isArray(data.ui) && typeof data.ui.panel === "string"
      ? [{ panel: data.ui.panel, params: data.ui.params }]
      : [];
  }
  if (header === "resume_generator" || header === "resume-generator") {
    if (data?.type === "analysis") return [{ panel: "resume.lab", params: { tab: data.analysis_type === "gap" ? "skill-gap" : "ats" } }];
    return [{ panel: "resume.lab", params: { tab: "generator" } }];
  }
  if (JOB_CREATION.has(header)) return [{ panel: "tpo.job-creator" }];
  if (PR_OUTREACH.has(header)) return [{ panel: "pr-outreach" }];
  if (ALUMNI.has(header)) return [{ panel: "alumni" }];
  if (INTERVIEW.has(header)) return [{ panel: "interview" }];
  if (GAP_ANALYSIS.has(header)) return [{ panel: "tpo.gap-analysis" }];
  if (LEARNING.has(header)) return [{ panel: "learning" }];
  // mode:jobparser:jobdetails, mode:switch:jobs|resume|job-eligibility|job-creation, mode:none, … → none
  return [];
}

/** Header-routed UI actions for one response chunk (copilot chunks → see copilotUiActions). */
export function routeHeader(payload) {
  const header = payload?.header_message;
  if (typeof header !== "string" || isCopilotHeader(header)) return [];
  const requestId = payload?.requestId ?? "";
  return headerActions(header, payload?.data).map((action) => ({
    ...action,
    id: `hdr:${requestId}:${action.panel}:${action.params?.tab ?? ""}`,
  }));
}

/** Cumulative `data.ui_actions` of a copilot chunk (AGENT-TOOLS.md §6). */
export function copilotUiActions(payload) {
  if (!isCopilotHeader(payload?.header_message)) return [];
  const actions = payload?.data?.ui_actions;
  return Array.isArray(actions) ? actions : [];
}
