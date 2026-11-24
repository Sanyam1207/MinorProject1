// Human chip label for a bot message's header_message (FRONTEND.md §8.4).
// `null` = render no chip (mode switches, mode:none, empty headers).
import { FAILURE_HEADERS } from "./agentModes.js";

const INTERVIEW_HEADERS = new Set(["button:options", "select:job:db", "text:mode:interview", "interview:end", "interview:audio"]);
const LEARNING_HEADERS = new Set(["select:interview:db", "learning:recommendations", "learning:recommendations-error"]);

export function headerLabel(header) {
  if (typeof header !== "string" || !header.trim()) return null;
  if (header.startsWith("mode:switch:") || header === "mode:none") return null;
  if (FAILURE_HEADERS.includes(header) && header !== "copilot:error") return "ERROR";
  if (header.startsWith("copilot:")) return "COPILOT";
  if (header.startsWith("mode:jobparser:")) return "JOB FINDER";
  if (header.startsWith("mode:jobCreation:")) return "JOB CREATOR";
  if (header.startsWith("mode:gapAnalysis:")) return "GAP ANALYSIS";
  if (header.startsWith("resume")) return "RESUME";
  if (header === "mail:review" || header.startsWith("pr_outreach")) return "PR OUTREACH";
  if (header.startsWith("alumni")) return "ALUMNI";
  if (INTERVIEW_HEADERS.has(header)) return "INTERVIEW";
  if (LEARNING_HEADERS.has(header)) return "LEARNING";
  return null;
}
