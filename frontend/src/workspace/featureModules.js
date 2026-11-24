// Non-component modules owned by other roles that shell components use
// (FRONTEND.md §11.1): the StudentMode tile summaries, the job view-model and
// the campus-jobs API used by the mock-interview picker.
//
// Resolved with import.meta.glob({ eager: true }) so the build never fails
// while those files do not exist yet: a present module is bundled exactly like
// a static import; a missing one falls back to the minimal implementation
// below (tiles show neutral badges, the interview picker reads the legacy
// /jobs list). The bindings are module constants, so hook identity is stable.
import { useSelector } from "react-redux";
import { api } from "../lib/api.js";
import { selectLatestJobs } from "../store/aiChatSlice.js";

const MODULES = import.meta.glob(
  [
    "../features/attendance/student/summary.js",
    "../features/opportunities/summary.js",
    "../features/opportunities/jobVM.js",
    "../lib/api/placements.js",
  ],
  { eager: true },
);

const attendanceSummary = MODULES["../features/attendance/student/summary.js"] ?? null;
const opportunitySummary = MODULES["../features/opportunities/summary.js"] ?? null;
const jobVM = MODULES["../features/opportunities/jobVM.js"] ?? null;
const placements = MODULES["../lib/api/placements.js"] ?? null;

// ─── Attendance summary (attendance-student) ────────────────────────────────

const NO_ATTENDANCE = Object.freeze({ overallPercent: null, status: "no-data", nextClass: null, loading: false, error: null });

function useAttendanceSummaryFallback() {
  return NO_ATTENDANCE;
}

/** → { overallPercent: number|null, status, nextClass: Session|null, loading, error } */
export const useAttendanceSummary =
  typeof attendanceSummary?.useAttendanceSummary === "function" ? attendanceSummary.useAttendanceSummary : useAttendanceSummaryFallback;

// ─── Opportunity summary (opportunities) ────────────────────────────────────

function useOpportunitySummaryFallback() {
  const latestJobs = useSelector(selectLatestJobs);
  return {
    campusCount: 0,
    aiMatches: Array.isArray(latestJobs) ? latestJobs.length : 0,
    applicationsActive: 0,
    offersPending: 0,
    trainingUpcoming: 0,
    loading: false,
    error: null,
  };
}

/** → { campusCount, aiMatches, applicationsActive, offersPending, trainingUpcoming, loading, error } */
export const useOpportunitySummary =
  typeof opportunitySummary?.useOpportunitySummary === "function" ? opportunitySummary.useOpportunitySummary : useOpportunitySummaryFallback;

// ─── Job view-model (opportunities) ─────────────────────────────────────────

const text = (value) => {
  if (value === null || value === undefined) return null;
  const string = String(value).trim();
  return string && string.toLowerCase() !== "not mentioned" ? string : null;
};
const list = (value) => (Array.isArray(value) ? value.filter(Boolean).map(String) : []);

function toJobVMFallback(raw, origin = "campus") {
  const company = raw?.company;
  const id = String(raw?.id ?? raw?._id ?? raw?.job_id ?? "");
  return {
    id,
    kind: origin === "market" || raw?.kind === "external" ? "external" : "campus",
    source: origin === "market" || raw?.kind === "external" ? "market" : "campus",
    origin,
    companyName: text(typeof company === "string" ? company : company?.name) ?? text(raw?.companyName ?? raw?.company_name) ?? "Company",
    companyLogo: raw?.companyLogo ?? raw?.company_logo ?? null,
    roleTitle: text(raw?.title ?? raw?.job_title ?? raw?.roleTitle) ?? "Role",
    location: text(raw?.location),
    salaryText: text(raw?.salary ?? raw?.ctc ?? raw?.packageLpa),
    jdText: text(raw?.description) ?? "",
    skillsRequired: list(raw?.skills ?? raw?.skillsRequired),
    applicationUrl: raw?.applicationUrl ?? raw?.application_url ?? null,
    jobType: text(raw?.employmentType ?? raw?.employment_type ?? raw?.job_type),
    minCgpa: Number.isFinite(Number(raw?.minimumCgpa ?? raw?.minCgpa)) ? Number(raw?.minimumCgpa ?? raw?.minCgpa) : null,
    deadline: raw?.applicationDeadline ?? raw?.deadline ?? null,
    raw,
  };
}

function toAgentJobFallback(vm) {
  return {
    _id: vm.id,
    id: vm.id,
    title: vm.roleTitle,
    job_title: vm.roleTitle,
    company_name: vm.companyName,
    company: vm.companyName,
    description: vm.jdText || "",
    skills: vm.skillsRequired || [],
    location: vm.location || "",
    salary: vm.salaryText || "",
    employment_type: vm.jobType || "",
    application_url: vm.applicationUrl || null,
    kind: vm.kind || "campus",
  };
}

export const toJobVM = typeof jobVM?.toJobVM === "function" ? jobVM.toJobVM : toJobVMFallback;
export const toAgentJob = typeof jobVM?.toAgentJob === "function" ? jobVM.toAgentJob : toAgentJobFallback;

// ─── Campus jobs API (opportunities) ────────────────────────────────────────

async function listCampusJobsFallback() {
  const envelope = await api.getJobs();
  const data = envelope?.data;
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.jobs) ? data.jobs : [];
  return { items: items.map((item) => toJobVM(item, "campus")), total: items.length, page: 1, hasNextPage: false };
}

/** → { items: JobVM[], total, page, hasNextPage } */
export const listCampusJobs = typeof placements?.listCampusJobs === "function" ? placements.listCampusJobs : listCampusJobsFallback;
