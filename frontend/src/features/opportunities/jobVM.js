// Job view-model (FRONTEND.md §13.3). Pure module — no React, no DOM.
//
// toJobVM(raw, origin) turns any job the app meets into one shape:
//   origin "campus" → placements StudentJobView / AgentJobSummary (PLACEMENTS.md)
//   origin "market" → PublicExternalJob (JOB-FEED.md §7.1)
//   origin "ai"     → JobsListItem from the Python jobs-finder (JOB-FEED.md §12.5; `kind` decides the source)
// List fields are never undefined and "Not mentioned"-style strings become null.

const EMPTY_TEXT = /^(not mentioned|not specified|not disclosed|n\/a|na|none|null|undefined|-|—)$/i;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

export const SOURCE_LABELS = Object.freeze({
  campus: "Campus",
  debugwithshubham: "DebugWithShubham",
  artha: "artha.link",
  whatsapp: "WhatsApp",
  sample: "Sample",
  crawl: "Web search",
});

export const sourceLabel = (name) => {
  const key = String(name ?? "").trim();
  if (!key) return "";
  return SOURCE_LABELS[key.toLowerCase()] ?? key;
};

const text = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const string = String(value).trim();
  return string && !EMPTY_TEXT.test(string) ? string : null;
};

const list = (value) => {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = [];
  for (const item of items) {
    const label = text(typeof item === "object" && item !== null ? item.name ?? item.label ?? item.value : item);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
};

const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const bool = (value) => (typeof value === "boolean" ? value : null);

const iso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const first = (...values) => {
  for (const value of values) if (value !== null && value !== undefined && value !== "") return value;
  return null;
};

const score = (value) => {
  const number = num(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
};

/** "12 LPA" / "₹12,00,000" / "1.2 Cr" / 12 → 12 (lakhs per annum), else null. */
export const parseLpa = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const string = text(value);
  if (!string) return null;
  const match = string.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (/\b(lpa|lakhs?|lacs?|l)\b/i.test(string)) return number;
  if (/\b(cr|crores?)\b/i.test(string)) return number * 100;
  if (/\b(k|month|pm|per month|stipend)\b/i.test(string)) return null;
  if (number >= 10000) return Math.round((number / 100000) * 10) / 10;
  return null;
};

const companyNameOf = (raw) => {
  const company = raw?.company;
  return (
    text(typeof company === "string" ? company : company?.name) ??
    text(raw?.companyName) ??
    text(raw?.company_name) ??
    null
  );
};

const roundsOf = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((round) => round && typeof round === "object")
    .map((round, index) => ({
      id: String(round._id ?? round.id ?? `round-${index}`),
      name: text(round.name) ?? `Round ${index + 1}`,
      at: iso(round.at ?? round.date),
      venue: text(round.venue),
      mode: text(round.mode),
      notes: text(round.notes),
    }));

const checksOf = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((check) => check && typeof check === "object")
    .map((check) => ({
      key: String(check.key ?? check.label ?? ""),
      label: text(check.label) ?? String(check.key ?? ""),
      required: check.required ?? null,
      actual: check.actual ?? null,
      passed: bool(check.passed),
    }));

const kindOf = (raw, origin) => {
  if (origin === "market") return "external";
  if (origin === "campus") return "campus";
  return raw?.kind === "external" ? "external" : raw?.kind === "campus" ? "campus" : raw?.saveable ? "external" : "campus";
};

const sourcesOf = (raw, kind) => {
  if (kind === "campus") return ["campus"];
  const names = list(raw?.sources);
  if (names.length) return names;
  const single = text(raw?.source);
  return single ? [single] : [];
};

const categoriesOf = (raw) => {
  const categories = list(raw?.categories);
  if (categories.length) return categories;
  const domain = text(raw?.job_domain ?? raw?.jobDomain);
  return domain && !/^(campus drive|other)$/i.test(domain) ? [domain] : [];
};

/**
 * @param {object} raw   any job payload
 * @param {"campus"|"market"|"ai"} origin
 */
export function toJobVM(raw, origin = "campus") {
  const job = raw && typeof raw === "object" ? raw : {};
  const kind = kindOf(job, origin);
  const source = kind === "campus" ? "campus" : "market";
  const id = String(first(job.id, job._id, job.job_id, job.jobId) ?? "");
  const sources = sourcesOf(job, kind);

  const eligibility = job.eligibility && typeof job.eligibility === "object" ? job.eligibility : null;
  const isEligible =
    kind !== "campus" ? null : bool(job.isEligible) ?? bool(job.is_eligible) ?? (eligibility ? bool(eligibility.eligible) : null);
  const reasons = list(first(job.eligibilityReasons, job.eligibility_reasons, eligibility?.reasons));
  const eligibilityReasons = reasons.length ? reasons : list(job.eligibilityReason ? [job.eligibilityReason] : []);
  const eligibilityStatus =
    kind !== "campus"
      ? null
      : text(eligibility?.status) ?? (isEligible === true ? "eligible" : isEligible === false ? "ineligible" : null);

  const packageLpa = num(job.packageLpa) ?? parseLpa(first(job.salary, job.ctc, job.packageLabel));
  const packageLabel = text(job.packageLabel);
  const salaryText =
    packageLabel ?? text(job.salary) ?? text(job.ctc) ?? text(job.stipend) ?? (packageLpa !== null ? `${packageLpa} LPA` : null);

  const myApplication = job.myApplication && typeof job.myApplication === "object" ? job.myApplication : null;
  const savedState = job.saved && typeof job.saved === "object" ? job.saved : null;
  const applicationStatus =
    kind === "campus"
      ? text(myApplication?.status) ?? text(job.applicationStatus) ?? text(job.application_status)
      : text(savedState?.status) ?? text(job.application_status) ?? text(job.applicationStatus);

  const saveable = kind === "external" && (origin === "market" || job.saveable === true) && OBJECT_ID.test(id);
  const hasDetail = OBJECT_ID.test(id);

  return {
    id,
    kind,
    source,
    origin,
    sources,
    sourceLabels: sources.map(sourceLabel).filter(Boolean),
    companyName: companyNameOf(job) ?? "Company",
    companyLogo: text(job.companyLogo ?? job.company_logo),
    roleTitle: text(first(job.title, job.roleTitle, job.job_title)) ?? "Role",
    location: text(job.location),
    salaryText,
    packageLpa,
    packageMaxLpa: num(job.packageMaxLpa),
    jdText: text(job.description ?? job.jdText) ?? "",
    skillsRequired: list(first(job.skillsRequired, job.skills)),
    applicationUrl: text(first(job.applicationUrl, job.application_url, job.applyUrl, job.apply_url)),
    deadline: iso(first(job.applicationDeadline, job.deadline)),
    driveDate: iso(job.driveDate ?? job.drive_date),
    postedAt: iso(first(job.postedAt, job.posted_at, job.publishedAt, job.createdAt)),
    jobType: text(first(job.employmentType, job.employment_type, job.jobType, job.job_type)),
    workType: text(job.workType ?? job.work_type),
    experience: text(job.experience),
    minCgpa: num(first(job.minimumCgpa, job.minCgpa, job.min_cgpa)),
    eligibleBranches: list(job.eligibleBranches),
    maxBacklogs: num(first(job.maximumBacklogs, job.maxBacklogs)),
    graduationYears: list(job.graduationYears),
    selectionProcess: text(job.selectionProcess ?? job.requirements),
    rounds: roundsOf(job.rounds),
    isEligible,
    eligibilityStatus,
    eligibilityReasons,
    eligibilityChecks: checksOf(eligibility?.checks),
    matchScore: score(first(job.matchScore, job.matchPercentage, job.match_score)),
    matchedSkills: list(first(job.matchedSkills, job.matched_skills)),
    missingSkills: list(job.missingSkills),
    applicationStatus,
    myApplication: myApplication ? { ...myApplication, _id: String(myApplication._id ?? myApplication.id ?? "") } : null,
    canApply: kind === "campus" ? bool(job.canApply) : null,
    applyBlockedReason: text(job.applyBlockedReason),
    isOpen: bool(job.isOpen),
    status: text(job.status),
    saved: kind === "external" ? applicationStatus : null,
    savedNotes: typeof savedState?.notes === "string" ? savedState.notes : "",
    saveable,
    hasDetail,
    isSample: job.isSample === true || job.is_sample === true,
    isNew: job.isNew === true,
    categories: categoriesOf(job),
    raw: job,
  };
}

/** The job shape the copilot expects in `journey.selectedJob` / `details.selected_job`. */
export function toAgentJob(vm) {
  const job = vm || {};
  return {
    _id: job.id,
    id: job.id,
    title: job.roleTitle,
    job_title: job.roleTitle,
    company_name: job.companyName,
    company: job.companyName,
    description: job.jdText || "",
    skills: Array.isArray(job.skillsRequired) ? job.skillsRequired : [],
    location: job.location || "",
    salary: job.salaryText || "",
    employment_type: job.jobType || "",
    application_url: job.applicationUrl || null,
    kind: job.kind || "campus",
  };
}

/** Merge a partial update into a VM list by id. */
export const patchJobs = (items, id, patch) =>
  (Array.isArray(items) ? items : []).map((item) => (item.id === id ? { ...item, ...patch } : item));
