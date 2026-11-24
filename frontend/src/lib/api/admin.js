// TPO / recruiter API client (FRONTEND.md §14.9). Paths, bodies and response
// shapes follow the backend as built: backend/src/modules/placements/routes/*,
// job-feed/routes.js, faculty/*.routes.js and issue-reports/issue-reports.routes.js.
// Every function goes through the shared `http` client (envelope unwrapped,
// errors normalised to ApiClientError, which is allowed to propagate).
import { http } from "../http.js";

const enc = (value) => encodeURIComponent(String(value ?? ""));

/** Drop undefined / null / "" values (and empty arrays) from a query object. */
const clean = (params = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) out[key] = value.join(",");
      continue;
    }
    out[key] = value;
  }
  return out;
};

/** Body helper: drop undefined / null / "" values, keep arrays as they are. */
const compact = (body = {}) =>
  Object.fromEntries(Object.entries(body || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));

const asArray = (value, ...keys) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
};

const toPaged = (data, key = "items") => {
  const items = asArray(data, key, "items");
  return {
    items,
    total: Number.isFinite(data?.total) ? data.total : items.length,
    page: data?.page ?? 1,
    limit: data?.limit ?? items.length,
    statusCounts: data?.statusCounts ?? null,
    counts: data?.counts ?? null,
    job: data?.job ?? null,
  };
};

// ── Drives (/jobs) ─────────────────────────────────────────────────────────

/** GET /jobs → StaffJobView[] for tpo/company. `status` = one, a comma list or "all". */
export async function listDrives({ status, query, sort, page, limit } = {}) {
  const data = await http.get("/jobs", {
    params: clean({ status: status || "all", q: query, sort, page, limit: limit ?? 200 }),
  });
  const items = asArray(data, "items", "jobs");
  return { items, total: Number.isFinite(data?.total) ? data.total : items.length };
}

export async function getDrive(jobId) {
  const data = await http.get(`/jobs/${enc(jobId)}`);
  return data?.job ?? data;
}

/** POST /jobs → `{ job, notifiedStudents }`. */
export async function createDrive(payload) {
  const data = await http.post("/jobs", payload);
  return { job: data?.job ?? data, notifiedStudents: data?.notifiedStudents ?? null };
}

export async function updateDrive(jobId, patch) {
  const data = await http.patch(`/jobs/${enc(jobId)}`, patch);
  return data?.job ?? data;
}

export async function deleteDrive(jobId) {
  return http.delete(`/jobs/${enc(jobId)}`);
}

/** POST /jobs/:id/publish (approve a pending company drive, or publish a draft). */
export async function publishDrive(jobId, { note } = {}) {
  const data = await http.post(`/jobs/${enc(jobId)}/publish`, compact({ note }));
  return { job: data?.job ?? data, notifiedStudents: data?.notifiedStudents ?? null };
}
export const approveDrive = publishDrive;

/** POST /jobs/:id/reject — `note` is required (3–500 chars). */
export async function rejectDrive(jobId, { note } = {}) {
  const data = await http.post(`/jobs/${enc(jobId)}/reject`, { note });
  return data?.job ?? data;
}

export async function closeDrive(jobId, { reason } = {}) {
  const data = await http.post(`/jobs/${enc(jobId)}/close`, compact({ reason }));
  return data?.job ?? data;
}

// ── Applications ───────────────────────────────────────────────────────────

const applicationQuery = ({ status, branch, passingYear, query, q, eligible, sort, page, limit } = {}) =>
  clean({ status, branch, passingYear, q: q ?? query, eligible, sort, page, limit });

/** GET /jobs/:id/applications → `{ items, total, page, limit, statusCounts, job }`. */
export async function listApplicants(jobId, filters = {}) {
  const data = await http.get(`/jobs/${enc(jobId)}/applications`, { params: applicationQuery(filters) });
  return toPaged(data);
}

/** GET /applications (every drive in scope) → `{ items, total, page, limit, statusCounts }`. */
export async function listApplications(filters = {}) {
  const data = await http.get("/applications", { params: applicationQuery(filters) });
  return toPaged(data);
}

export async function getApplication(applicationId) {
  const data = await http.get(`/applications/${enc(applicationId)}`);
  return data?.application ?? data;
}

/** PATCH /applications/:id/status → `{ application, changed }`. */
export async function updateApplicationStatus(applicationId, { status, note } = {}) {
  const data = await http.patch(`/applications/${enc(applicationId)}/status`, compact({ status, note }));
  return { application: data?.application ?? null, changed: data?.changed !== false };
}

/** POST /applications/bulk-status → `{ updated, unchanged, failed: [{id, code, message}] }`. */
export async function bulkUpdateApplicationStatus({ applicationIds, status, note } = {}) {
  const data = await http.post("/applications/bulk-status", compact({ applicationIds, status, note }));
  return { updated: data?.updated ?? 0, unchanged: data?.unchanged ?? 0, failed: asArray(data?.failed) };
}

/** GET /applications/:id/resume → `{ url, expiresAt }` (short-lived signed link). */
export async function getApplicationResumeUrl(applicationId) {
  return http.get(`/applications/${enc(applicationId)}/resume`);
}

/** CSV export as a Blob (per drive when `jobId` is given). */
export async function exportApplicationsCsv({ jobId, ...filters } = {}) {
  const params = applicationQuery(filters);
  delete params.page;
  delete params.limit;
  delete params.sort;
  const path = jobId ? `/jobs/${enc(jobId)}/applications/export.csv` : "/applications/export.csv";
  return http.get(path, { params, responseType: "blob" });
}

// ── Offers and policy ──────────────────────────────────────────────────────

/** GET /offers → `{ offers, total, statusCounts }`. */
export async function listOffers({ status, q, query, jobId, academicYear, page, limit } = {}) {
  const data = await http.get("/offers", {
    params: clean({ status: status || "all", q: q ?? query, jobId, academicYear, page, limit }),
  });
  const offers = asArray(data, "offers", "items");
  return {
    offers,
    total: Number.isFinite(data?.total) ? data.total : offers.length,
    statusCounts: data?.statusCounts ?? null,
  };
}

/** POST /offers → OfferStaffView. Body: `applicationId` or `studentId` + `jobId`/`companyName`. */
export async function createOffer(body) {
  const data = await http.post("/offers", compact(body));
  return data?.offer ?? data;
}

export async function updateOffer(offerId, patch) {
  const data = await http.patch(`/offers/${enc(offerId)}`, compact(patch));
  return data?.offer ?? data;
}

export async function markOfferPlaced(offerId) {
  const data = await http.post(`/offers/${enc(offerId)}/place`, {});
  return data?.offer ?? data;
}

/** POST /offers/:id/override `{ newStatus, note }` (note 3–500 chars). */
export async function overrideOffer(offerId, { newStatus, note } = {}) {
  const data = await http.post(`/offers/${enc(offerId)}/override`, { newStatus, note });
  return data?.offer ?? data;
}

/** POST /offers/:id/revoke `{ reason }` (3–500 chars). */
export async function revokeOffer(offerId, { reason } = {}) {
  const data = await http.post(`/offers/${enc(offerId)}/revoke`, { reason });
  return data?.offer ?? data;
}

/** GET /offers/policy → PolicyView (defaults with `isDefault: true` when nothing is saved). */
export async function getPlacementPolicy({ academicYear } = {}) {
  return http.get("/offers/policy", { params: clean({ academicYear }) });
}

/** PUT /offers/policy → PolicyView. */
export async function savePlacementPolicy(policy) {
  const body = {
    academicYear: policy?.academicYear,
    enforceOneOffer: Boolean(policy?.enforceOneOffer),
    allowDreamUpgrade: Boolean(policy?.allowDreamUpgrade),
    dreamMultiplier: Number(policy?.dreamMultiplier),
    superDreamMultiplier: Number(policy?.superDreamMultiplier),
    maxPendingOffers: Number(policy?.maxPendingOffers),
    offerExpiryDays: Number(policy?.offerExpiryDays),
  };
  if (policy?.collegeId) body.collegeId = policy.collegeId;
  return http.put("/offers/policy", body);
}

// ── Placements (/placements) ───────────────────────────────────────────────

/** GET /placements/me → `{ role, college, company, academicYear }`. */
export async function getPlacementContext() {
  return http.get("/placements/me");
}

/** GET /placements/stats (tpo). */
export async function getPlacementStats({ academicYear, branch, passingYear } = {}) {
  return http.get("/placements/stats", { params: clean({ academicYear, branch, passingYear }) });
}

/** POST /placements/announcements → `{ recipients: number }`. */
export async function sendAnnouncement({ title, body, audience, email } = {}) {
  return http.post("/placements/announcements", { title, body, audience: audience || {}, email: email !== false });
}

// ── Training (/training) ───────────────────────────────────────────────────

export async function listPrograms({ status = "all", q, query, type } = {}) {
  const data = await http.get("/training", { params: clean({ status, q: q ?? query, type }) });
  return asArray(data, "programs", "items");
}

export async function getProgram(programId) {
  const data = await http.get(`/training/${enc(programId)}`);
  return data?.program ?? data;
}

export async function createProgram(body) {
  const data = await http.post("/training", body);
  return data?.program ?? data;
}

export async function updateProgram(programId, patch) {
  const data = await http.patch(`/training/${enc(programId)}`, patch);
  return data?.program ?? data;
}

export async function cancelProgram(programId, { reason } = {}) {
  const data = await http.post(`/training/${enc(programId)}/cancel`, compact({ reason }));
  return data?.program ?? data;
}

export async function deleteProgram(programId) {
  return http.delete(`/training/${enc(programId)}`);
}

/** GET /training/:id/enrollments → `{ program, enrollments }`. */
export async function listProgramEnrollments(programId) {
  const data = await http.get(`/training/${enc(programId)}/enrollments`);
  return { program: data?.program ?? null, enrollments: asArray(data, "enrollments", "items") };
}

/** POST /training/:id/attendance `{ sessionIndex, studentIds, present }` → `{ updated }`. */
export async function markProgramAttendance(programId, { sessionIndex, studentIds, present }) {
  return http.post(`/training/${enc(programId)}/attendance`, { sessionIndex, studentIds, present: Boolean(present) });
}

export async function updateProgramEnrollment(programId, enrollmentId, patch) {
  const data = await http.patch(`/training/${enc(programId)}/enrollments/${enc(enrollmentId)}`, compact(patch));
  return data?.enrollment ?? data;
}

// ── Job feed ───────────────────────────────────────────────────────────────

/** POST /job-feed/sync → `{ run, alreadyRunning }` (202 while it runs in the background). */
export async function triggerJobFeedSync() {
  const data = await http.post("/job-feed/sync", {});
  return { run: data?.run ?? null, alreadyRunning: Boolean(data?.alreadyRunning) };
}

/** GET /job-feed/sync/status → `{ running, current, lastRun, lastSuccessfulRun, recentRuns, schedule, sources, whatsapp, totals }`. */
export async function getJobFeedSyncStatus() {
  return http.get("/job-feed/sync/status");
}

/** GET /job-feed (read-only browse for the TPO). */
export async function listMarketJobs({ query, category, jobType, workType, location, source, sort, page, limit } = {}) {
  const data = await http.get("/job-feed", {
    params: clean({ q: query, category, jobType, workType, location, source, sort, page, limit: limit ?? 20 }),
  });
  return toPaged(data, "jobs");
}

// ── Provisioned accounts (faculty / recruiters) ────────────────────────────

const accountsApi = (base) => ({
  /** → `{ items, total, page, limit }`. */
  async list({ query, department, company, status, page, limit } = {}) {
    const data = await http.get(base, { params: clean({ search: query, department, company, status, page, limit }) });
    return toPaged(data);
  },
  /** → `{ user, delivery: "email"|"manual", temporaryPassword?, emailError? }`. */
  async invite(body) {
    return http.post(base, compact(body));
  },
  async update(id, patch) {
    const data = await http.patch(`${base}/${enc(id)}`, patch);
    return data?.user ?? data;
  },
  async deactivate(id) {
    const data = await http.delete(`${base}/${enc(id)}`);
    return data?.user ?? data;
  },
  /** → `{ user, delivery, temporaryPassword? }`. */
  async resetPassword(id, { sendEmail = true } = {}) {
    return http.post(`${base}/${enc(id)}/reset-password`, { sendEmail });
  },
});

export const facultyApi = accountsApi("/faculty");
export const recruitersApi = accountsApi("/recruiters");

export const listFaculty = (params) => facultyApi.list(params);
export const inviteFaculty = (body) => facultyApi.invite(body);
export const updateFaculty = (id, patch) => facultyApi.update(id, patch);
export const deactivateFaculty = (id) => facultyApi.deactivate(id);
export const resetFacultyPassword = (id, options) => facultyApi.resetPassword(id, options);
/** A new temporary password is the "resend invite" for a provisioned account. */
export const resendFacultyInvite = (id) => facultyApi.resetPassword(id, { sendEmail: true });

export const listRecruiters = (params) => recruitersApi.list(params);
export const inviteRecruiter = (body) => recruitersApi.invite(body);
export const updateRecruiter = (id, patch) => recruitersApi.update(id, patch);
export const deactivateRecruiter = (id) => recruitersApi.deactivate(id);
export const resetRecruiterPassword = (id, options) => recruitersApi.resetPassword(id, options);

/** POST /faculty/reveal `{ revealId }` → `{ email, temporaryPassword }` (one time; 404 REVEAL_EXPIRED). */
export async function revealTemporaryPassword(revealId) {
  return http.post("/faculty/reveal", { revealId });
}

// ── Issue reports ──────────────────────────────────────────────────────────

/** GET /issue-reports → `{ items, total, page, limit, counts }`. */
export async function listIssueReports({ status, search, page, limit } = {}) {
  const data = await http.get("/issue-reports", { params: clean({ status: status === "all" ? undefined : status, search, page, limit }) });
  return toPaged(data);
}

/** PATCH /issue-reports/:id `{ status?, note? }` → report. */
export async function updateIssueReport(reportId, { status, note } = {}) {
  const body = {};
  if (status !== undefined) body.status = status;
  if (note !== undefined) body.note = note;
  const data = await http.patch(`/issue-reports/${enc(reportId)}`, body);
  return data?.report ?? data;
}
