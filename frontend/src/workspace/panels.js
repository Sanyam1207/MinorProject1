// Panel registry — the frontend copy of UI-ACTIONS.md §3–§5 (that file wins on
// any conflict). Pure module: no React, no DOM; imported by `node --test`.
//
// Each panel:
//   title      human title (chips "→ OPENED …", back bars)
//   target     { mode | modeByRole, feature?, jobsTab?, resumeTool?, resumeToolParam? } for workspace panels,
//              { overlay } for overlays. A key that is absent means "leave that state untouched".
//   roles      roles that may open it directly
//   aliases    role → panel id used instead when the role is not in `roles`
//   keyAliases incoming param key → canonical key (applied before sanitising)
//   params     declared params (anything else is dropped)
//   component  "path under src/ · export (owner)" — documentation only

const ALL_ROLES = Object.freeze(["student", "teacher", "tpo", "admin", "company", "alumni"]);

const id = (extra = {}) => ({ type: "id", ...extra });
const str = () => ({ type: "string" });
const text = () => ({ type: "text" });
const num = (min, max) => ({ type: "number", min, max });
const int = (min, max, defaultValue) => ({ type: "integer", min, max, default: defaultValue });
const bool = () => ({ type: "boolean" });
const oneOf = (values, defaultValue) => ({ type: "enum", values, default: defaultValue });
const date = () => ({ type: "date" });
const idList = () => ({ type: "idList" });

const JOB_TYPES = ["full-time", "part-time", "internship", "contract"];
const WORK_TYPES = ["onsite", "remote", "hybrid"];

const panel = (definition) => Object.freeze({ aliases: {}, keyAliases: {}, params: {}, ...definition });

export const PANELS = Object.freeze({
  // 3.1 Student mode
  "student.home": panel({ title: "Student home", target: { mode: "student", feature: null }, roles: ["student"], component: "pages/StudentMode.jsx · StudentMode (shell)" }),
  "jobs.matched": panel({ title: "AI-matched jobs", target: { mode: "student", feature: "drives", jobsTab: "matched" }, roles: ["student"], component: "features/opportunities/JobsHub.jsx · JobsHub (opportunities)" }),
  "jobs.campus": panel({
    title: "Campus drives", target: { mode: "student", feature: "drives", jobsTab: "campus" }, roles: ["student"],
    aliases: { tpo: "tpo.drives", admin: "tpo.drives", company: "company.drives" },
    params: { query: str(), location: str(), minPackageLpa: num(), eligibleOnly: bool() },
    component: "features/opportunities/JobsHub.jsx · JobsHub (opportunities)",
  }),
  "jobs.market": panel({
    title: "Open-market jobs", target: { mode: "student", feature: "drives", jobsTab: "market" }, roles: ["student"],
    aliases: { tpo: "tpo.job-feed", admin: "tpo.job-feed" },
    keyAliases: { q: "query" },
    params: {
      query: str(), category: str(), jobType: oneOf(JOB_TYPES), workType: oneOf(WORK_TYPES), location: str(),
      source: str(), sort: oneOf(["newest", "match"]), highlightIds: idList(), page: int(1, 1000),
    },
    component: "features/opportunities/JobsHub.jsx · JobsHub (opportunities)",
  }),
  "jobs.tracker": panel({
    title: "Saved & applied", target: { mode: "student", feature: "drives", jobsTab: "tracker" }, roles: ["student"],
    params: { status: oneOf(["saved", "applied", "interviewing", "offer", "rejected"]), highlightId: id() },
    component: "features/opportunities/JobsHub.jsx · JobsHub (opportunities)",
  }),
  "jobs.detail": panel({
    title: "Job details", target: { mode: "student", feature: "drives", jobsTab: "detail" }, roles: ["student"],
    aliases: { tpo: "tpo.drives", admin: "tpo.drives", company: "company.drives" },
    params: { jobId: id({ required: true }), source: oneOf(["campus", "market"], "campus"), from: oneOf(["matched", "campus", "market", "tracker"]) },
    component: "features/opportunities/JobsHub.jsx · JobsHub (opportunities)",
  }),
  applications: panel({
    title: "My applications", target: { mode: "student", feature: "applications" }, roles: ["student"],
    aliases: { tpo: "tpo.applicants", admin: "tpo.applicants", company: "company.applicants" },
    params: { status: str(), applicationId: id() },
    component: "features/opportunities/ApplicationsPanel.jsx · ApplicationsPanel (opportunities)",
  }),
  offers: panel({
    title: "My offers", target: { mode: "student", feature: "offers" }, roles: ["student"],
    aliases: { tpo: "tpo.offers", admin: "tpo.offers" },
    params: { offerId: id(), status: str() },
    component: "components/StudentOffers.jsx · StudentOffers (opportunities)",
  }),
  training: panel({
    title: "Training programs", target: { mode: "student", feature: "training" }, roles: ["student"],
    aliases: { tpo: "tpo.training", admin: "tpo.training" },
    params: { tab: oneOf(["discover", "mine"], "discover"), programId: id() },
    component: "components/TrainingHub.jsx · TrainingHub (opportunities)",
  }),
  calendar: panel({
    title: "Placement calendar", target: { mode: "student", feature: "calendar" }, roles: ["student"],
    aliases: { tpo: "tpo.calendar", admin: "tpo.calendar" },
    params: { date: date() },
    component: "features/opportunities/CalendarPanel.jsx · CalendarPanel (opportunities)",
  }),
  portfolio: panel({
    title: "My portfolio", target: { mode: "student", feature: "portfolio" }, roles: ["student"],
    params: { tab: oneOf(["profile", "projects", "experience"], "profile") },
    component: "pages/StudentMode.jsx · inline portfolio (shell)",
  }),
  "attendance.student": panel({
    title: "My attendance", target: { mode: "student", feature: "attendance" }, roles: ["student"],
    aliases: { teacher: "teacher.courses", tpo: "tpo.attendance", admin: "tpo.attendance" },
    params: { courseId: id(), tab: oneOf(["overview", "history"], "overview") },
    component: "features/attendance/student/StudentAttendancePanel.jsx · StudentAttendancePanel (attendance-student)",
  }),
  "attendance.scan": panel({
    title: "Scan attendance QR", target: { mode: "student", feature: "attendance-scan" }, roles: ["student"],
    component: "features/attendance/student/ScanPanel.jsx · ScanPanel (attendance-student)",
  }),
  schedule: panel({
    title: "Class schedule", target: { mode: "student", feature: "schedule" }, roles: ["student"],
    aliases: { teacher: "teacher.schedule" },
    params: { days: int(1, 31, 7), date: date() },
    component: "features/attendance/student/StudentSchedulePanel.jsx · StudentSchedulePanel (attendance-student)",
  }),
  interview: panel({
    title: "AI mock interview", target: { mode: "student", feature: "mock-interview" }, roles: ["student"],
    component: "components/InterviewWorkspace.jsx · InterviewWorkspace (shell)",
  }),
  learning: panel({
    title: "Learning roadmap", target: { mode: "student", feature: "learning-recommendation" }, roles: ["student"],
    params: { interviewId: id() },
    component: "components/LearningRecommendationWorkspace.jsx · LearningRecommendationWorkspace (shell)",
  }),

  // 3.2 Resume Lab
  "resume.home": panel({
    title: "Resume Lab", target: { mode: "resume", resumeTool: null }, roles: ["student"],
    component: "pages/ResumeStudio.jsx · ResumeStudio (resume)",
  }),
  "resume.lab": panel({
    title: "Resume Lab tool", target: { mode: "resume", resumeToolParam: "tab" }, roles: ["student"],
    params: {
      tab: oneOf(["catalog", "editor", "tailor", "ats", "generator", "skill-gap"], "catalog"),
      resumeId: id(), jobId: id(), jobSource: oneOf(["campus", "market"]), credentialId: id(),
    },
    component: "pages/ResumeStudio.jsx · ResumeStudio → per-tab component (resume)",
  }),
  "settings.ai-keys": panel({
    title: "AI keys (BYOK)", target: { mode: "resume", resumeTool: "ai-keys" }, roles: ["student"],
    params: { provider: oneOf(["openai", "anthropic", "google", "xai"]) },
    component: "features/resume/AiKeysPanel.jsx · AiKeysPanel via ResumeStudio (resume)",
  }),

  // 3.3 Other student modes
  alumni: panel({
    title: "Alumni connect", target: { modeByRole: { student: "alumni_connect", alumni: "alumni" } }, roles: ["student", "alumni"],
    component: "pages/AlumniConnect.jsx · AlumniConnect (shell)",
  }),
  "pr-outreach": panel({
    title: "PR & outreach", target: { mode: "pr_outreach" }, roles: ["student", "tpo", "admin"],
    component: "pages/PROutreach.jsx · PROutreach (shell)",
  }),

  // 3.4 Teacher mode
  "teacher.home": panel({ title: "Teacher home", target: { mode: "teacher", feature: null }, roles: ["teacher"], component: "pages/TeacherMode.jsx · TeacherMode (attendance-teacher)" }),
  "teacher.courses": panel({
    title: "My courses", target: { mode: "teacher", feature: "courses" }, roles: ["teacher"],
    aliases: { tpo: "tpo.attendance", admin: "tpo.attendance" },
    params: { courseId: id(), tab: oneOf(["overview", "students", "timetable", "settings"], "overview"), create: bool() },
    component: "features/attendance/teacher/CoursesPanel.jsx (attendance-teacher)",
  }),
  "teacher.schedule": panel({
    title: "Class schedule", target: { mode: "teacher", feature: "schedule" }, roles: ["teacher"],
    params: { sessionId: id(), courseId: id(), date: date(), view: oneOf(["list", "week"], "list"), create: bool() },
    component: "features/attendance/teacher/SchedulePanel.jsx (attendance-teacher)",
  }),
  "teacher.live": panel({
    title: "Live attendance", target: { mode: "teacher", feature: "live" }, roles: ["teacher"],
    params: { sessionId: id() },
    component: "features/attendance/teacher/LiveSessionPanel.jsx (attendance-teacher)",
  }),
  "teacher.report": panel({
    title: "Session report", target: { mode: "teacher", feature: "report" }, roles: ["teacher"],
    aliases: { tpo: "tpo.attendance", admin: "tpo.attendance" },
    params: { sessionId: id(), courseId: id(), date: date() },
    component: "features/attendance/teacher/SessionReportPanel.jsx (attendance-teacher)",
  }),
  "teacher.analytics": panel({
    title: "Course analytics", target: { mode: "teacher", feature: "analytics" }, roles: ["teacher"],
    aliases: { tpo: "tpo.attendance", admin: "tpo.attendance" },
    params: { courseId: id(), threshold: num(0, 100) },
    component: "features/attendance/teacher/CourseAnalyticsPanel.jsx (attendance-teacher)",
  }),

  // 3.5 TPO mode (admin always has exactly the tpo rights)
  "tpo.home": panel({ title: "TPO home", target: { mode: "tpo", feature: null }, roles: ["tpo", "admin"], component: "pages/AdminMode.jsx · AdminMode (shell)" }),
  "tpo.job-creator": panel({ title: "AI job creator", target: { mode: "tpo", feature: "job-creator" }, roles: ["tpo", "admin"], component: "pages/AdminMode.jsx · JobCreatorPanel (shell)" }),
  "tpo.gap-analysis": panel({ title: "Curriculum gap analysis", target: { mode: "tpo", feature: "gap-analysis" }, roles: ["tpo", "admin"], component: "components/GapAnalysisPanel.jsx · GapAnalysisPanel (tpo)" }),
  "tpo.drives": panel({
    title: "Placement drives", target: { mode: "tpo", feature: "job-postings" }, roles: ["tpo", "admin"],
    aliases: { company: "company.drives" },
    params: { jobId: id(), status: str(), query: str(), create: bool() },
    component: "features/tpo/DrivesPanel.jsx · DrivesPanel {scope:'tpo'} (tpo)",
  }),
  "tpo.applicants": panel({
    title: "Applicants", target: { mode: "tpo", feature: "application-review" }, roles: ["tpo", "admin"],
    aliases: { company: "company.applicants" },
    params: { jobId: id(), status: str(), applicationId: id() },
    component: "features/tpo/ApplicantsPanel.jsx · ApplicantsPanel {scope:'tpo'} (tpo)",
  }),
  "tpo.offers": panel({
    title: "Offer management", target: { mode: "tpo", feature: "offer-management" }, roles: ["tpo", "admin"],
    aliases: { company: "company.applicants" },
    params: { status: str(), offerId: id(), applicationId: id(), create: bool() },
    component: "components/OfferManagement.jsx · OfferManagement (tpo)",
  }),
  "tpo.policy": panel({
    title: "Placement policy", target: { mode: "tpo", feature: "policy-configuration" }, roles: ["tpo", "admin"],
    params: { academicYear: str() },
    component: "components/PolicyConfigPanel.jsx · PolicyConfigPanel (tpo)",
  }),
  "tpo.analytics": panel({
    title: "Placement analytics", target: { mode: "tpo", feature: "placement-analytics" }, roles: ["tpo", "admin"],
    params: { academicYear: str(), branch: str() },
    component: "features/tpo/PlacementAnalyticsPanel.jsx · PlacementAnalyticsPanel (tpo)",
  }),
  "tpo.training": panel({
    title: "Training scheduler", target: { mode: "tpo", feature: "training-scheduler" }, roles: ["tpo", "admin"],
    params: { programId: id(), create: bool() },
    component: "components/TrainingScheduler.jsx · TrainingScheduler (tpo)",
  }),
  "tpo.calendar": panel({
    title: "Drive calendar", target: { mode: "tpo", feature: "placement-calendar" }, roles: ["tpo", "admin"],
    params: { date: date() },
    component: "features/tpo/TpoCalendarPanel.jsx · TpoCalendarPanel (tpo)",
  }),
  "tpo.job-feed": panel({
    title: "Job feed (market)", target: { mode: "tpo", feature: "job-feed" }, roles: ["tpo", "admin"],
    keyAliases: { q: "query" },
    params: {
      runId: id(), query: str(), category: str(), jobType: oneOf(JOB_TYPES), workType: oneOf(WORK_TYPES),
      location: str(), source: str(), sort: oneOf(["newest", "match"]),
    },
    component: "features/tpo/JobFeedAdminPanel.jsx · JobFeedAdminPanel (tpo)",
  }),
  "tpo.faculty": panel({
    title: "Faculty", target: { mode: "tpo", feature: "faculty" }, roles: ["tpo", "admin"],
    // + revealId/highlightId/department/status: the faculty tools' `ui` params as actually built (coordinator, 2026-11-25).
    params: {
      query: str(), facultyId: id(), invite: bool(), revealId: id(), highlightId: id(), department: str(),
      status: oneOf(["active", "inactive", "invited", "all"]),
    },
    component: "features/tpo/FacultyPanel.jsx · FacultyPanel (tpo)",
  }),
  "tpo.recruiters": panel({
    title: "Recruiters", target: { mode: "tpo", feature: "recruiters" }, roles: ["tpo", "admin"],
    params: { query: str(), recruiterId: id(), invite: bool(), highlightId: id(), revealInviteId: id() },
    component: "features/tpo/RecruitersPanel.jsx · RecruitersPanel (tpo)",
  }),
  "tpo.attendance": panel({
    title: "Attendance oversight", target: { mode: "tpo", feature: "attendance-oversight" }, roles: ["tpo", "admin"],
    params: { courseId: id(), sessionId: id(), threshold: num(0, 100) },
    component: "features/attendance/teacher/AttendanceOversightPanel.jsx · AttendanceOversightPanel (attendance-teacher)",
  }),
  "tpo.issues": panel({
    title: "Issue reports", target: { mode: "tpo", feature: "issue-reports" }, roles: ["tpo", "admin"],
    params: { status: str(), reportId: id() },
    component: "features/tpo/IssueReportsPanel.jsx · IssueReportsPanel (tpo)",
  }),

  // 3.6 Company mode
  "company.home": panel({ title: "Recruiter home", target: { mode: "company", feature: null }, roles: ["company"], component: "pages/CompanyMode.jsx · CompanyMode (tpo)" }),
  "company.drives": panel({
    title: "My drives", target: { mode: "company", feature: "drives" }, roles: ["company"],
    params: { jobId: id(), status: str(), query: str(), create: bool() },
    component: "features/tpo/DrivesPanel.jsx · DrivesPanel {scope:'company'} via CompanyMode (tpo)",
  }),
  "company.applicants": panel({
    title: "Applicants", target: { mode: "company", feature: "applicants" }, roles: ["company"],
    params: { jobId: id(), status: str(), applicationId: id() },
    component: "features/tpo/ApplicantsPanel.jsx · ApplicantsPanel {scope:'company'} via CompanyMode (tpo)",
  }),

  // 3.7 Overlays (every role)
  notifications: panel({
    title: "Notifications", target: { overlay: "notifications" }, roles: ALL_ROLES,
    params: { tab: oneOf(["inbox", "preferences"], "inbox") },
    component: "features/notifications/NotificationPanel.jsx · NotificationPanel (shell)",
  }),
  profile: panel({
    title: "Edit profile", target: { overlay: "profile" }, roles: ALL_ROLES,
    params: { tab: str() },
    component: "components/ProfileModal.jsx · ProfileModal (shell)",
  }),
  "report-issue": panel({
    title: "Report an issue", target: { overlay: "report-issue" }, roles: ALL_ROLES,
    params: { description: text() },
    component: "features/help/ReportIssueModal.jsx · ReportIssueModal (shell)",
  }),
});

/** UI-ACTIONS.md §3.8 — deprecated ids rewritten before resolution. */
export const PANEL_ID_ALIASES = Object.freeze({ "tpo.jobfeed": "tpo.job-feed" });

/** UI-ACTIONS.md §4 — the exact `open_panel` enum per role (a test asserts equality). */
export const PANELS_BY_ROLE = Object.freeze({
  student: ["student.home", "jobs.matched", "jobs.campus", "jobs.market", "jobs.tracker", "jobs.detail",
    "applications", "offers", "training", "calendar", "portfolio",
    "attendance.student", "attendance.scan", "schedule", "interview", "learning",
    "resume.home", "resume.lab", "settings.ai-keys", "alumni", "pr-outreach",
    "notifications", "profile", "report-issue"],
  teacher: ["teacher.home", "teacher.courses", "teacher.schedule", "teacher.live", "teacher.report",
    "teacher.analytics", "notifications", "profile", "report-issue"],
  tpo: ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
    "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
    "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"],
  admin: ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
    "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
    "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"],
  company: ["company.home", "company.drives", "company.applicants", "notifications", "profile", "report-issue"],
  alumni: ["alumni", "notifications", "profile", "report-issue"],
});

// ─── Param sanitisation (UI-ACTIONS.md §5) ───────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const isScalar = (value) => ["string", "number", "boolean"].includes(typeof value);
const INVALID = Symbol("invalid");

const toId = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  return ID_PATTERN.test(trimmed) ? trimmed : INVALID;
};

const toText = (value, max) => {
  if (!isScalar(value)) return INVALID;
  if (typeof value === "number" && !Number.isFinite(value)) return INVALID;
  const trimmed = String(value).trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : INVALID;
};

const toNumber = (value, min, max) => {
  if (typeof value === "string" && value.trim() === "") return INVALID;
  if (typeof value !== "number" && typeof value !== "string") return INVALID;
  const number = Number(value);
  if (!Number.isFinite(number)) return INVALID;
  let clamped = number;
  if (typeof min === "number") clamped = Math.max(min, clamped);
  if (typeof max === "number") clamped = Math.min(max, clamped);
  return clamped;
};

const toBoolean = (value) => {
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  if (value === false || value === 0 || value === "false" || value === "0") return false;
  return INVALID;
};

const toEnum = (value, values) => {
  if (typeof value !== "string") return INVALID;
  const lower = value.trim().toLowerCase();
  return values.find((member) => member.toLowerCase() === lower) ?? INVALID;
};

const toDate = (value) => {
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`)) ? INVALID : trimmed;
  if (ISO_DATETIME.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) return trimmed;
  return INVALID;
};

const toIdList = (value) => {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!items) return INVALID;
  const ids = [];
  for (const item of items) {
    const parsed = toId(item);
    if (parsed !== INVALID && !ids.includes(parsed)) ids.push(parsed);
    if (ids.length >= 20) break;
  }
  return ids.length ? ids : INVALID;
};

const coerce = (spec, value) => {
  switch (spec.type) {
    case "id": return toId(value);
    case "string": return toText(value, 200);
    case "text": return toText(value, 2000);
    case "number": return toNumber(value, spec.min, spec.max);
    case "integer": {
      const number = toNumber(value, spec.min, spec.max);
      return number === INVALID ? INVALID : Math.round(number);
    }
    case "boolean": return toBoolean(value);
    case "enum": return toEnum(value, spec.values);
    case "date": return toDate(value);
    case "idList": return toIdList(value);
    default: return INVALID;
  }
};

/** Rewrite a deprecated panel id (UI-ACTIONS.md §3.8). */
export const canonicalPanelId = (panelId) => PANEL_ID_ALIASES[panelId] ?? panelId;

/**
 * Sanitise params against a panel's declaration.
 * → `{ params, missing }` where `missing` lists required keys that are absent after sanitising.
 */
export function sanitizeParams(panelId, rawParams) {
  const definition = PANELS[canonicalPanelId(panelId)];
  if (!definition) return { params: {}, missing: [] };
  const input = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams) ? { ...rawParams } : {};
  for (const [from, to] of Object.entries(definition.keyAliases)) {
    if (from in input) {
      if (!(to in input) || input[to] === undefined || input[to] === null) input[to] = input[from];
      delete input[from];
    }
  }
  const params = {};
  const missing = [];
  for (const [key, spec] of Object.entries(definition.params)) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      const coerced = coerce(spec, value);
      if (coerced !== INVALID) params[key] = coerced;
    }
    if (!(key in params) && spec.default !== undefined) params[key] = spec.default;
    if (!(key in params) && spec.required) missing.push(key);
  }
  return { params, missing };
}

/**
 * Resolve a panel for a role: rewrites deprecated ids, follows role aliases (max 2 hops).
 * → `{ ok: true, panelId, panel }` | `{ ok: false, reason: "UNKNOWN_PANEL" | "FORBIDDEN" }`
 */
export function resolvePanel(panelId, role) {
  let currentId = canonicalPanelId(panelId);
  if (!PANELS[currentId]) return { ok: false, reason: "UNKNOWN_PANEL" };
  for (let hop = 0; hop <= 2; hop += 1) {
    const definition = PANELS[currentId];
    if (!definition) return { ok: false, reason: "UNKNOWN_PANEL" };
    if (definition.roles.includes(role)) return { ok: true, panelId: currentId, panel: definition };
    const next = definition.aliases[role];
    if (!next || hop === 2) break;
    currentId = canonicalPanelId(next);
  }
  return { ok: false, reason: "FORBIDDEN" };
}

export const isOverlayPanel = (panelId) => Boolean(PANELS[canonicalPanelId(panelId)]?.target.overlay);

/**
 * Concrete state target for a resolved panel. Keys left `undefined` mean "untouched".
 * → `{ kind: "overlay", overlay }` | `{ kind: "workspace", mode, feature?, jobsTab?, resumeTool? }`
 */
export function resolveTarget(panelId, role, params = {}) {
  const definition = PANELS[canonicalPanelId(panelId)];
  if (!definition) return null;
  const { target } = definition;
  if (target.overlay) return { kind: "overlay", overlay: target.overlay };
  const mode = target.mode ?? target.modeByRole?.[role] ?? null;
  if (!mode) return null;
  const resolved = { kind: "workspace", mode };
  if ("feature" in target) resolved.feature = target.feature;
  if ("jobsTab" in target) resolved.jobsTab = target.jobsTab;
  if ("resumeTool" in target) resolved.resumeTool = target.resumeTool;
  if (target.resumeToolParam) {
    resolved.resumeTool = params[target.resumeToolParam] ?? definition.params[target.resumeToolParam]?.default ?? null;
  }
  return resolved;
}

export const panelTitle = (panelId) => PANELS[canonicalPanelId(panelId)]?.title ?? String(panelId ?? "");

const FULL_HEIGHT_RESUME_TABS = new Set(["generator", "editor", "tailor"]);

/** UI-ACTIONS.md §3.2: these panels manage their own scroll (the right column stops scrolling). */
export const isFullHeightPanel = (panelId, params = {}) =>
  canonicalPanelId(panelId) === "resume.lab" && FULL_HEIGHT_RESUME_TABS.has(params?.tab);

export const isFullHeightResumeTool = (tool) => FULL_HEIGHT_RESUME_TABS.has(tool);
