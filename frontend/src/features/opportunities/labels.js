// Display helpers shared by the opportunities panels (pure).

export const JOB_TYPE_OPTIONS = Object.freeze([
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "internship", label: "Internship" },
  { value: "contract", label: "Contract" },
]);

export const WORK_TYPE_OPTIONS = Object.freeze([
  { value: "onsite", label: "On-site" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
]);

export const TRACKER_LABELS = Object.freeze({
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
});

export const APPLICATION_LABELS = Object.freeze({
  applied: "Applied",
  shortlisted: "Shortlisted",
  interview: "Interview",
  offered: "Offer received",
  hired: "Hired",
  rejected: "Not selected",
  withdrawn: "Withdrawn",
});

/** Application statuses a student may still withdraw from. */
export const WITHDRAWABLE = new Set(["applied", "shortlisted", "interview"]);

/** application status → STATUS_COLORS.application key */
export const applicationColorKey = (status) => (status === "hired" ? "selected" : status);

export const ELIGIBILITY_BADGES = Object.freeze({
  eligible: { label: "ELIGIBLE", className: "bg-green-200" },
  override: { label: "ELIGIBLE (TPO OVERRIDE)", className: "bg-green-200" },
  ineligible: { label: "NOT ELIGIBLE", className: "bg-red-100" },
  incomplete: { label: "PROFILE INCOMPLETE", className: "bg-yellow-100" },
  unknown: { label: "ELIGIBILITY UNKNOWN", className: "bg-gray-100" },
});

export const eligibilityBadge = (vm) => {
  if (!vm || vm.kind !== "campus") return null;
  if (vm.eligibilityStatus && ELIGIBILITY_BADGES[vm.eligibilityStatus]) return ELIGIBILITY_BADGES[vm.eligibilityStatus];
  if (vm.isEligible === true) return ELIGIBILITY_BADGES.eligible;
  if (vm.isEligible === false) return ELIGIBILITY_BADGES.ineligible;
  return null;
};

const OPTION_LABEL = Object.fromEntries([...JOB_TYPE_OPTIONS, ...WORK_TYPE_OPTIONS].map((option) => [option.value, option.label]));

/** "full-time" → "Full-time"; unknown values are shown as given. */
export const typeLabel = (value) => (value ? OPTION_LABEL[String(value).toLowerCase()] ?? String(value) : null);

export const humanize = (value) => String(value ?? "").replace(/[-_]+/g, " ").trim();

/** Safe external URL (http/https only) or null. */
export const safeUrl = (value) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

export const openExternal = (url) => {
  const safe = safeUrl(url);
  if (safe && typeof window !== "undefined") window.open(safe, "_blank", "noopener,noreferrer");
  return Boolean(safe);
};
