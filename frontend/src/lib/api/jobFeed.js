// Open-market job feed API (FRONTEND.md §14.6, JOB-FEED.md §7) over lib/http.js.
// Paths verified against backend/src/modules/job-feed/routes.js.
import { toJobVM } from "../../features/opportunities/jobVM.js";
import { http } from "../http.js";

const id = (value) => encodeURIComponent(String(value ?? ""));
const clean = (params) =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));

export const TRACKER_STATUSES = Object.freeze(["saved", "applied", "interviewing", "offer", "rejected"]);

/** SavedJobView → normalised, with `vm` built from the live job or the snapshot. */
export const normalizeSavedJob = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const snapshot = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : {};
  const live = raw.job && typeof raw.job === "object" ? raw.job : null;
  const base = live ?? { ...snapshot, id: raw.jobId, kind: "external" };
  const vm = toJobVM({ ...base, saved: { status: raw.status, notes: raw.notes } }, "market");
  return {
    ...raw,
    id: String(raw.id ?? raw._id ?? ""),
    jobId: String(raw.jobId ?? live?.id ?? ""),
    status: TRACKER_STATUSES.includes(raw.status) ? raw.status : "saved",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    history: Array.isArray(raw.history) ? raw.history.filter(Boolean) : [],
    jobAvailable: raw.jobAvailable !== false && Boolean(live),
    vm,
  };
};

/**
 * GET /job-feed → { items: JobVM[], page, limit, total, hasNextPage, filters }
 */
export async function listMarketJobs({ query, category, jobType, workType, location, source, sort, page = 1, limit = 10 } = {}) {
  const data = await http.get("/job-feed", {
    params: clean({ q: query, category, jobType, workType, location, source, sort, page, limit }),
  });
  const jobs = Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : [];
  return {
    items: jobs.map((job) => toJobVM(job, "market")),
    page: Number(data?.page) || page,
    limit: Number(data?.limit) || limit,
    total: Number.isFinite(Number(data?.total)) ? Number(data.total) : jobs.length,
    hasNextPage: Boolean(data?.hasNextPage),
    filters: data?.filters ?? {},
  };
}

/** GET /job-feed/:id → JobVM */
export async function getMarketJob(jobId) {
  const data = await http.get(`/job-feed/${id(jobId)}`);
  return toJobVM(data?.job ?? data, "market");
}

/** GET /job-feed/categories → [{ value, count }] */
export async function listMarketCategories() {
  const data = await http.get("/job-feed/categories");
  const categories = Array.isArray(data?.categories) ? data.categories : Array.isArray(data) ? data : [];
  return categories.filter((entry) => entry && entry.value);
}

/** GET /job-feed/sources → SourceInfo[] ({ name, label, kind, enabled, count, lastSyncedAt, lastError }) */
export async function listMarketSources() {
  const data = await http.get("/job-feed/sources");
  const sources = Array.isArray(data?.sources) ? data.sources : Array.isArray(data) ? data : [];
  return sources.filter((entry) => entry && entry.name);
}

/** GET /job-feed/saved → { items: SavedJobView[], counts, page, limit, total, hasNextPage } */
export async function listSavedJobs({ status, page, limit } = {}) {
  const data = await http.get("/job-feed/saved", { params: clean({ status, page, limit }) });
  const items = (Array.isArray(data?.items) ? data.items : []).map(normalizeSavedJob).filter(Boolean);
  const counts = { saved: 0, applied: 0, interviewing: 0, offer: 0, rejected: 0, total: 0, ...(data?.counts || {}) };
  return {
    items,
    counts,
    page: Number(data?.page) || 1,
    limit: Number(data?.limit) || items.length,
    total: Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length,
    hasNextPage: Boolean(data?.hasNextPage),
  };
}

/** PUT /job-feed/saved/:jobId {status?, notes?} → SavedJobView */
export async function saveMarketJob(jobId, { status, notes } = {}) {
  const body = {};
  if (status) body.status = status;
  if (typeof notes === "string") body.notes = notes;
  const data = await http.put(`/job-feed/saved/${id(jobId)}`, body);
  return normalizeSavedJob(data?.item ?? data);
}

/** DELETE /job-feed/saved/:jobId */
export async function removeSavedJob(jobId) {
  await http.delete(`/job-feed/saved/${id(jobId)}`);
}
