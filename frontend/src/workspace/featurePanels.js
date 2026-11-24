// Feature components owned by OTHER frontend roles (FRONTEND.md §11.1),
// loaded through this single registry.
//
// Why import.meta.glob: these files are written by the attendance-teacher,
// attendance-student, opportunities, resume and tpo roles, possibly after the
// shell. A static `import()` of a file that does not exist fails the
// production build; `import.meta.glob` (eager: false) only emits loaders for
// files that exist at build time. A component whose file is missing (or has
// no default export) rejects with PanelUnavailableError at render time, and
// <FeatureSlot> shows "This panel is not available yet" for that panel only —
// the rest of the app keeps working. Each component still loads lazily in its
// own chunk. The shell creates NO placeholder files in other owners'
// directories. Rebuild after those files land; nothing here needs editing.
import { lazy } from "react";

const LOADERS = import.meta.glob([
  "../pages/TeacherMode.jsx",
  "../pages/ResumeStudio.jsx",
  "../pages/CompanyMode.jsx",
  "../features/attendance/teacher/PresenterPage.jsx",
  "../features/attendance/teacher/AttendanceOversightPanel.jsx",
  "../features/attendance/student/AttendPage.jsx",
  "../features/attendance/student/StudentAttendancePanel.jsx",
  "../features/attendance/student/ScanPanel.jsx",
  "../features/attendance/student/StudentSchedulePanel.jsx",
  "../features/opportunities/JobsHub.jsx",
  "../features/opportunities/ApplicationsPanel.jsx",
  "../features/opportunities/CalendarPanel.jsx",
  "../components/StudentOffers.jsx",
  "../components/TrainingHub.jsx",
  "../features/tpo/DrivesPanel.jsx",
  "../features/tpo/ApplicantsPanel.jsx",
  "../features/tpo/PlacementAnalyticsPanel.jsx",
  "../features/tpo/TpoCalendarPanel.jsx",
  "../features/tpo/JobFeedAdminPanel.jsx",
  "../features/tpo/FacultyPanel.jsx",
  "../features/tpo/RecruitersPanel.jsx",
  "../features/tpo/IssueReportsPanel.jsx",
  "../components/OfferManagement.jsx",
  "../components/PolicyConfigPanel.jsx",
  "../components/TrainingScheduler.jsx",
  "../components/GapAnalysisPanel.jsx",
]);

/** name → { path, owner }  (paths relative to src/, as in FRONTEND.md §11.1 / UI-ACTIONS.md §3). */
export const FEATURE_COMPONENTS = Object.freeze({
  TeacherMode: { path: "../pages/TeacherMode.jsx", owner: "attendance-teacher" },
  PresenterPage: { path: "../features/attendance/teacher/PresenterPage.jsx", owner: "attendance-teacher" },
  AttendanceOversightPanel: { path: "../features/attendance/teacher/AttendanceOversightPanel.jsx", owner: "attendance-teacher" },
  AttendPage: { path: "../features/attendance/student/AttendPage.jsx", owner: "attendance-student" },
  StudentAttendancePanel: { path: "../features/attendance/student/StudentAttendancePanel.jsx", owner: "attendance-student" },
  ScanPanel: { path: "../features/attendance/student/ScanPanel.jsx", owner: "attendance-student" },
  StudentSchedulePanel: { path: "../features/attendance/student/StudentSchedulePanel.jsx", owner: "attendance-student" },
  JobsHub: { path: "../features/opportunities/JobsHub.jsx", owner: "opportunities" },
  ApplicationsPanel: { path: "../features/opportunities/ApplicationsPanel.jsx", owner: "opportunities" },
  CalendarPanel: { path: "../features/opportunities/CalendarPanel.jsx", owner: "opportunities" },
  StudentOffers: { path: "../components/StudentOffers.jsx", owner: "opportunities" },
  TrainingHub: { path: "../components/TrainingHub.jsx", owner: "opportunities" },
  ResumeStudio: { path: "../pages/ResumeStudio.jsx", owner: "resume" },
  CompanyMode: { path: "../pages/CompanyMode.jsx", owner: "tpo" },
  DrivesPanel: { path: "../features/tpo/DrivesPanel.jsx", owner: "tpo" },
  ApplicantsPanel: { path: "../features/tpo/ApplicantsPanel.jsx", owner: "tpo" },
  PlacementAnalyticsPanel: { path: "../features/tpo/PlacementAnalyticsPanel.jsx", owner: "tpo" },
  TpoCalendarPanel: { path: "../features/tpo/TpoCalendarPanel.jsx", owner: "tpo" },
  JobFeedAdminPanel: { path: "../features/tpo/JobFeedAdminPanel.jsx", owner: "tpo" },
  FacultyPanel: { path: "../features/tpo/FacultyPanel.jsx", owner: "tpo" },
  RecruitersPanel: { path: "../features/tpo/RecruitersPanel.jsx", owner: "tpo" },
  IssueReportsPanel: { path: "../features/tpo/IssueReportsPanel.jsx", owner: "tpo" },
  OfferManagement: { path: "../components/OfferManagement.jsx", owner: "tpo" },
  PolicyConfigPanel: { path: "../components/PolicyConfigPanel.jsx", owner: "tpo" },
  TrainingScheduler: { path: "../components/TrainingScheduler.jsx", owner: "tpo" },
  GapAnalysisPanel: { path: "../components/GapAnalysisPanel.jsx", owner: "tpo" },
});

export class PanelUnavailableError extends Error {
  constructor(name, reason = "missing") {
    const info = FEATURE_COMPONENTS[name];
    super(`${name} is not available yet (${info?.path?.replace("../", "src/") ?? name}, ${reason}).`);
    this.name = "PanelUnavailableError";
    this.component = name;
    this.owner = info?.owner ?? null;
  }
}

/** Whether the component's file exists in this build. */
export const isFeatureAvailable = (name) => Boolean(LOADERS[FEATURE_COMPONENTS[name]?.path]);

const loadFeature = async (name) => {
  const loader = LOADERS[FEATURE_COMPONENTS[name]?.path];
  if (!loader) throw new PanelUnavailableError(name);
  const module = await loader();
  if (typeof module?.default !== "function" && typeof module?.default !== "object") {
    throw new PanelUnavailableError(name, "no default export");
  }
  return { default: module.default };
};

// Created once at module scope (never during render).
export const FEATURE_LAZY = Object.freeze(
  Object.fromEntries(Object.keys(FEATURE_COMPONENTS).map((name) => [name, lazy(() => loadFeature(name))])),
);
