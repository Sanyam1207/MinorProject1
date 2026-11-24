// Right-hand workspace panels the copilot may open, per role.
//
// PANELS_BY_ROLE is a verbatim copy of docs/contracts/UI-ACTIONS.md §4 (the
// enum offered by the open_panel tool: direct panels only, aliases are a
// frontend safety net). PANEL_TITLES are the "Title" column of §3.
// UI-ACTIONS.md is the single source of truth: update both together.

const freezeLists = (map) => Object.freeze(Object.fromEntries(
    Object.entries(map).map(([role, panels]) => [role, Object.freeze([...panels])]),
));

const TPO_PANELS = [
    "tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
    "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
    "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue",
];

export const PANELS_BY_ROLE = freezeLists({
    student: [
        "student.home", "jobs.matched", "jobs.campus", "jobs.market", "jobs.tracker", "jobs.detail",
        "applications", "offers", "training", "calendar", "portfolio",
        "attendance.student", "attendance.scan", "schedule", "interview", "learning",
        "resume.home", "resume.lab", "settings.ai-keys", "alumni", "pr-outreach",
        "notifications", "profile", "report-issue",
    ],
    teacher: [
        "teacher.home", "teacher.courses", "teacher.schedule", "teacher.live", "teacher.report",
        "teacher.analytics", "notifications", "profile", "report-issue",
    ],
    tpo: TPO_PANELS,
    // `admin` always has exactly the `tpo` rights (UI-ACTIONS.md §3).
    admin: TPO_PANELS,
    company: ["company.home", "company.drives", "company.applicants", "notifications", "profile", "report-issue"],
    alumni: ["alumni", "notifications", "profile", "report-issue"],
});

export const PANEL_TITLES = Object.freeze({
    "student.home": "Student home",
    "jobs.matched": "AI-matched jobs",
    "jobs.campus": "Campus drives",
    "jobs.market": "Open-market jobs",
    "jobs.tracker": "Saved & applied",
    "jobs.detail": "Job details",
    applications: "My applications",
    offers: "My offers",
    training: "Training programs",
    calendar: "Placement calendar",
    portfolio: "My portfolio",
    "attendance.student": "My attendance",
    "attendance.scan": "Scan attendance QR",
    schedule: "Class schedule",
    interview: "AI mock interview",
    learning: "Learning roadmap",
    "resume.home": "Resume Lab",
    "resume.lab": "Resume Lab tool",
    "settings.ai-keys": "AI keys (BYOK)",
    alumni: "Alumni connect",
    "pr-outreach": "PR & outreach",
    "teacher.home": "Teacher home",
    "teacher.courses": "My courses",
    "teacher.schedule": "Class schedule",
    "teacher.live": "Live attendance",
    "teacher.report": "Session report",
    "teacher.analytics": "Course analytics",
    "tpo.home": "TPO home",
    "tpo.job-creator": "AI job creator",
    "tpo.gap-analysis": "Curriculum gap analysis",
    "tpo.drives": "Placement drives",
    "tpo.applicants": "Applicants",
    "tpo.offers": "Offer management",
    "tpo.policy": "Placement policy",
    "tpo.analytics": "Placement analytics",
    "tpo.training": "Training scheduler",
    "tpo.calendar": "Drive calendar",
    "tpo.job-feed": "Job feed (market)",
    "tpo.faculty": "Faculty",
    "tpo.recruiters": "Recruiters",
    "tpo.attendance": "Attendance oversight",
    "tpo.issues": "Issue reports",
    "company.home": "Recruiter home",
    "company.drives": "My drives",
    "company.applicants": "Applicants",
    notifications: "Notifications",
    profile: "Edit profile",
    "report-issue": "Report an issue",
});

/** Panel ids the given role may open directly ([] for an unknown role). */
export const panelsForRole = (role) => PANELS_BY_ROLE[role] ?? [];
