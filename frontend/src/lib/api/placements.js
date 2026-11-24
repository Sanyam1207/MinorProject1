// Placements API for students (FRONTEND.md §14.5) over lib/http.js.
// Paths verified against backend/src/modules/placements/routes/*.js; shapes
// against services/views.js. Every function resolves with normalised data.
import { toJobVM } from "../../features/opportunities/jobVM.js";
import { http } from "../http.js";

const id = (value) => encodeURIComponent(String(value ?? ""));
const arr = (value) => (Array.isArray(value) ? value : []);
const listOf = (data, ...keys) => {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
};
const clean = (params) =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));

// ─── Normalisers ─────────────────────────────────────────────────────────────

export const normalizeApplication = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const job = raw.job && typeof raw.job === "object" ? raw.job : {};
  const company = job.company;
  return {
    ...raw,
    _id: String(raw._id ?? raw.id ?? ""),
    status: typeof raw.status === "string" ? raw.status : "applied",
    statusLabel: raw.statusLabel || "",
    appliedAt: raw.appliedAt ?? raw.createdAt ?? null,
    job: {
      ...job,
      _id: String(job._id ?? job.id ?? (typeof raw.job === "string" ? raw.job : "")),
      title: job.title || "Drive",
      companyName: job.companyName || (typeof company === "string" ? company : company?.name) || "Company",
      packageLabel: job.packageLabel || "Not disclosed",
    },
    timeline: arr(raw.timeline).filter((entry) => entry && typeof entry === "object"),
    resume: raw.resume && typeof raw.resume === "object" ? raw.resume : null,
    coverNote: typeof raw.coverNote === "string" ? raw.coverNote : "",
    offer: raw.offer && typeof raw.offer === "object" ? raw.offer : null,
  };
};

export const normalizeOffer = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    _id: String(raw._id ?? raw.id ?? ""),
    status: typeof raw.status === "string" ? raw.status : "extended",
    offerType: raw.offerType || "normal",
    companyName: raw.companyName || "Company",
    roleTitle: raw.roleTitle || raw.job?.title || "Role",
    packageLpa: Number.isFinite(Number(raw.packageLpa)) ? Number(raw.packageLpa) : null,
    currentAcceptedPackage:
      raw.currentAcceptedPackage === null || raw.currentAcceptedPackage === undefined || !Number.isFinite(Number(raw.currentAcceptedPackage))
        ? null
        : Number(raw.currentAcceptedPackage),
    statusHistory: arr(raw.statusHistory).filter((entry) => entry && typeof entry === "object"),
  };
};

export const normalizeProgram = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const capacity = Number(raw.capacity);
  const enrolled = Number(raw.enrolledCount);
  return {
    ...raw,
    _id: String(raw._id ?? raw.id ?? ""),
    title: raw.title || "Training program",
    status: typeof raw.status === "string" && raw.status ? raw.status : "upcoming",
    type: raw.type || "other",
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
    enrolledCount: Number.isFinite(enrolled) && enrolled > 0 ? enrolled : 0,
    seatsLeft: Number.isFinite(Number(raw.seatsLeft)) ? Number(raw.seatsLeft) : null,
    schedule: arr(raw.schedule).filter((session) => session && typeof session === "object"),
    isRegistered: raw.isRegistered === true,
  };
};

export const normalizeEnrollment = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    _id: String(raw._id ?? raw.id ?? ""),
    program: normalizeProgram(raw.program),
    completionStatus: raw.completionStatus || "enrolled",
    attendance: arr(raw.attendance),
    certificateUrl: raw.certificateUrl || null,
  };
};

// ─── Drives ──────────────────────────────────────────────────────────────────

/**
 * GET /jobs (students get StudentJobView[] — eligibility, match %, my application).
 * The endpoint returns a plain page, so `total` is a lower bound and
 * `hasNextPage` is "this page was full".
 * → { items: JobVM[], total, page, hasNextPage }
 */
export async function listCampusJobs({ query, location, minPackageLpa, eligibleOnly, sort, status, page = 1, limit = 20 } = {}) {
  const data = await http.get("/jobs", {
    params: clean({ q: query, location, minPackageLpa, eligibleOnly: eligibleOnly ? true : undefined, sort, status, page, limit }),
  });
  const rows = listOf(data, "items", "jobs");
  const items = rows.map((row) => toJobVM(row, "campus"));
  const pageNumber = Number(data?.page) || page;
  return {
    items,
    total: Number.isFinite(Number(data?.total)) ? Number(data.total) : (pageNumber - 1) * limit + items.length,
    page: pageNumber,
    hasNextPage: typeof data?.hasNextPage === "boolean" ? data.hasNextPage : items.length >= limit,
  };
}

/** GET /jobs/matched → JobVM[] (eligible, open drives by match %). */
export async function listMatchedCampusJobs({ limit = 20 } = {}) {
  const data = await http.get("/jobs/matched", { params: { limit } });
  return listOf(data, "items", "jobs").map((row) => toJobVM(row, "campus"));
}

/** GET /jobs/:id → JobVM */
export async function getCampusJob(jobId) {
  const data = await http.get(`/jobs/${id(jobId)}`);
  return toJobVM(data?.job ?? data, "campus");
}

/** POST /jobs/:id/apply {resumeId?, coverNote?} → Application */
export async function applyToJob(jobId, { resumeId, coverNote } = {}) {
  const data = await http.post(`/jobs/${id(jobId)}/apply`, clean({ resumeId, coverNote: coverNote?.trim() || undefined }));
  return normalizeApplication(data?.application ?? data);
}

// ─── Applications ────────────────────────────────────────────────────────────

/** GET /applications/my?status= → Application[] */
export async function listMyApplications({ status } = {}) {
  const data = await http.get("/applications/my", { params: clean({ status }) });
  return listOf(data, "items", "applications").map(normalizeApplication).filter(Boolean);
}

/** POST /applications/:id/withdraw {reason?} → Application|null */
export async function withdrawApplication(applicationId, reason) {
  const data = await http.post(`/applications/${id(applicationId)}/withdraw`, clean({ reason }));
  return normalizeApplication(data?.application ?? data);
}

// ─── Offers ──────────────────────────────────────────────────────────────────

/** GET /offers/my → Offer[] */
export async function listMyOffers() {
  const data = await http.get("/offers/my");
  return listOf(data, "items", "offers").map(normalizeOffer).filter(Boolean);
}

/** GET /offers/policy → the active one-offer policy for the caller's college. */
export async function getOfferPolicy() {
  return http.get("/offers/policy");
}

/** POST /offers/:id/accept → { offer, released: [{_id, companyName, packageLpa}] } */
export async function acceptOffer(offerId) {
  const data = await http.post(`/offers/${id(offerId)}/accept`);
  return { offer: normalizeOffer(data?.offer ?? data), released: arr(data?.released) };
}

/** POST /offers/:id/reject {reason} → Offer */
export async function rejectOffer(offerId, reason) {
  const data = await http.post(`/offers/${id(offerId)}/reject`, clean({ reason }));
  return normalizeOffer(data?.offer ?? data);
}

/** POST /offers/:id/withdraw {reason} → Offer (accepted → withdrawn) */
export async function withdrawOfferAcceptance(offerId, reason) {
  const data = await http.post(`/offers/${id(offerId)}/withdraw`, clean({ reason }));
  return normalizeOffer(data?.offer ?? data);
}

// ─── Training ────────────────────────────────────────────────────────────────

/** GET /training → Program[] (students: audience matches, with isRegistered). */
export async function listTrainingPrograms({ status, type, query } = {}) {
  const data = await http.get("/training", { params: clean({ status, type, q: query }) });
  return listOf(data, "items", "programs").map(normalizeProgram).filter(Boolean);
}

/** GET /training/my → Enrollment[] (registered only). */
export async function listMyTraining() {
  const data = await http.get("/training/my");
  return listOf(data, "items", "enrollments").map(normalizeEnrollment).filter(Boolean);
}

/** POST /training/:id/register → Enrollment */
export async function registerForTraining(programId) {
  const data = await http.post(`/training/${id(programId)}/register`);
  return normalizeEnrollment(data?.enrollment ?? data);
}

/** DELETE /training/:id/register → Enrollment */
export async function unregisterFromTraining(programId) {
  const data = await http.delete(`/training/${id(programId)}/register`);
  return normalizeEnrollment(data?.enrollment ?? data);
}

// ─── Calendar (optional endpoint) ────────────────────────────────────────────

let calendarUnsupported = false;

/** GET /calendar?from&to → CalendarEvent[]; `null` when the server has no such endpoint (remembered). */
export async function getPlacementCalendar({ from, to } = {}) {
  if (calendarUnsupported) return null;
  try {
    const data = await http.get("/calendar", { params: clean({ from, to }) });
    const events = listOf(data, "events", "items");
    return events;
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) {
      calendarUnsupported = true;
      return null;
    }
    throw error;
  }
}
