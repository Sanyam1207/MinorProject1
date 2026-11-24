// Single source of truth for role → allowed workspace modes (FRONTEND.md §4.1).
// Used by App/WorkspaceView, ModeDropdown, WelcomeModeSelect, the AI request
// handler and applyUiActions — a mode the role cannot use is never forced.

export const ROLE_MODES = Object.freeze({
  student: ["student", "resume", "pr_outreach", "alumni_connect"],
  teacher: ["teacher"],
  tpo: ["tpo", "pr_outreach"],
  admin: ["tpo", "pr_outreach"],
  company: ["company"],
  alumni: ["alumni"],
});

// icon = lucide icon NAME (mapped to components by src/workspace/icons.js)
export const MODE_DEFS = Object.freeze({
  student: { id: "student", label: "Student Mode", badge: "Placements & attendance", icon: "GraduationCap", home: "student.home", description: "Jobs, applications, offers, training, attendance and your class schedule" },
  resume: { id: "resume", label: "Resume Lab", badge: "LaTeX + AI", icon: "Files", home: "resume.home", description: "Resume catalog, editor, AI tailoring, ATS score and generator" },
  pr_outreach: { id: "pr_outreach", label: "PR & Outreach", badge: "AI mail workspace", icon: "Mail", home: "pr-outreach", description: "Draft, review and send professional outreach" },
  alumni_connect: { id: "alumni_connect", label: "Alumni Connect", badge: "Mentorship", icon: "Users", home: "alumni", description: "Find alumni mentors and manage requests" },
  alumni: { id: "alumni", label: "Alumni Portal", badge: "Mentor workspace", icon: "Users", home: "alumni", description: "Review requests and mentor students" },
  teacher: { id: "teacher", label: "Teacher Mode", badge: "Faculty workspace", icon: "Presentation", home: "teacher.home", description: "Courses, class schedule, live QR attendance and reports" },
  tpo: { id: "tpo", label: "College TPO Mode", badge: "Placement cell", icon: "ShieldCheck", home: "tpo.home", description: "Drives, applicants, offers, policy, analytics and faculty" },
  company: { id: "company", label: "Recruiter Mode", badge: "Company", icon: "Building2", home: "company.home", description: "Post drives and review applicants" },
});

export const ROLE_LABELS = Object.freeze({
  student: "Student",
  teacher: "Faculty",
  tpo: "TPO",
  admin: "Admin",
  company: "Recruiter",
  alumni: "Alumni",
});

export const allowedModesFor = (role) => ROLE_MODES[role] ?? ROLE_MODES.student; // unknown role = student
export const defaultModeFor = (role) => allowedModesFor(role)[0];
export const isModeAllowed = (role, mode) => allowedModesFor(role).includes(mode);
export const needsModeChoice = (role) => (ROLE_MODES[role] ? role === "student" : true);

/** Home panel of a mode (mode dropdown, switchMode, "BACK TO … HOME"). */
export const homePanelFor = (mode) => MODE_DEFS[mode]?.home ?? "student.home";

/** Sticky agent mode implied by a workspace mode (switchMode). */
export const agentModeForMode = (mode) =>
  mode === "pr_outreach" ? "pr_outreach" : mode === "alumni_connect" ? "alumni-connect" : null;

/** A mode that is valid for the role: the stored one when allowed, else the role default. */
export const resolveModeForRole = (role, mode) => (mode && isModeAllowed(role, mode) ? mode : defaultModeFor(role));

export const roleLabel = (role) => ROLE_LABELS[role] ?? (role ? String(role) : "Student");
