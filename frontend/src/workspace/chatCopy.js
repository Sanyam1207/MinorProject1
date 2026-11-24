// Chat header title + input placeholder by mode/role (FRONTEND.md §8.4).

export function chatTitle({ activeMode, activeFeature, role }) {
  if (activeMode === "pr_outreach") return "PR & OUTREACH ASSISTANT";
  if (activeFeature === "mock-interview" && activeMode === "student") return "AI INTERVIEW COACH";
  if (role === "teacher" || activeMode === "teacher") return "TEACHING COPILOT";
  if (role === "tpo" || role === "admin" || activeMode === "tpo") return "PLACEMENT CELL COPILOT";
  return "CAMPUS COPILOT";
}

export function chatPlaceholder({ activeMode, activeFeature, role }) {
  if (activeMode === "pr_outreach") return "Tell the agent who you want to reach and why...";
  if (activeFeature === "mock-interview" && activeMode === "student") return "Answer the interview question...";
  if (role === "teacher") return "Schedule a class, start attendance, find defaulters…";
  if (role === "tpo" || role === "admin") return "Ask about drives, applicants, offers or stats…";
  if (role === "company") return "Ask about your drives and applicants…";
  if (role === "alumni") return "Ask about your mentorship requests…";
  return "Ask about jobs, attendance, applications or your resume…";
}
