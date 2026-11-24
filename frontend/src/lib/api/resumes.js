// Resume Lab API (FRONTEND.md §14.7, verified against RESUME-BYOK.md §8 and
// backend/src/modules/resume-lab/routes/*.js).
//
//   /api/v1/resumes       catalog (list, create/upload, edit, delete, restore,
//                         primary, duplicate, apply-patches, score, compile, access, file)
//   /api/v1/resume        legacy upload + ATS score (+ preview)
//   /api/v1/resume-bank   generated-resume bank (alumni sharing depends on it)
//   /api/v1/jobs, /api/v1/job-feed   read-only job pickers for tailoring / scoring
//
// Pure module (no window/document at import time). Errors are ApiClientError.
import { ApiClientError, http } from "../http.js";

const id = (value) => encodeURIComponent(String(value ?? ""));

export const RESUME_UPLOAD_ACCEPT = ".pdf,.docx,.tex,.txt";
export const RESUME_UPLOAD_EXTENSIONS = Object.freeze(["pdf", "docx", "tex", "txt"]);
export const RESUME_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const COMPILE_TIMEOUT_MS = 90000;
const UPLOAD_TIMEOUT_MS = 60000;

// ── normalisers ────────────────────────────────────────────────────────────

/** ResumeSummary with safe defaults (backend serializeSummary, RESUME-BYOK §2.5). */
export const normalizeResume = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const resumeId = raw.id ?? raw._id;
  if (!resumeId) return null;
  const kind = typeof raw.kind === "string" ? raw.kind : "latex";
  return {
    ...raw,
    id: String(resumeId),
    _id: String(resumeId),
    title: typeof raw.title === "string" && raw.title ? raw.title : "Untitled resume",
    kind,
    origin: raw.origin || "generated",
    status: raw.status || "active",
    version: raw.version ?? null,
    revision: Number.isInteger(raw.revision) ? raw.revision : 1,
    isPrimary: Boolean(raw.isPrimary),
    locked: Boolean(raw.locked),
    editable: raw.editable ?? ((kind === "latex" || kind === "text") && !raw.locked && (raw.status || "active") === "active"),
    hasPdf: raw.hasPdf ?? (kind === "pdf" || kind === "latex"),
    sizeBytes: Number(raw.sizeBytes ?? raw.storage?.bytes) || 0,
    atsScore: Number.isFinite(raw.atsScore) ? raw.atsScore : null,
    targetJob: raw.targetJob ?? null,
    parentId: raw.parentId ?? null,
    extractionWarning: raw.extractionWarning ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
};

const normalizeResumeList = (items) => (Array.isArray(items) ? items.map(normalizeResume).filter(Boolean) : []);

// ── catalog ────────────────────────────────────────────────────────────────

/** `{resumes, primaryId, limit}` — `status`: active (default) | archived | all. */
export async function listResumeCatalog({ status = "active", kind } = {}) {
  const params = {};
  if (status && status !== "active") params.status = status;
  if (kind) params.kind = kind;
  const data = await http.get("/resumes", { params });
  const resumes = normalizeResumeList(Array.isArray(data) ? data : data?.resumes);
  return {
    resumes,
    primaryId: data?.primaryId ? String(data.primaryId) : resumes.find((resume) => resume.isPrimary)?.id ?? null,
    limit: Number.isFinite(data?.limit) ? data.limit : null,
  };
}

/** Active resumes as a plain array (read-only export for the opportunities apply dialog). */
export async function listResumes(options = {}) {
  return (await listResumeCatalog(options)).resumes;
}

/** `{resume, content, contentKind: "latex"|"text"|"extracted"}`. */
export async function getResume(resumeId) {
  const data = await http.get(`/resumes/${id(resumeId)}`);
  return {
    resume: normalizeResume(data?.resume),
    content: typeof data?.content === "string" ? data.content : "",
    contentKind: data?.contentKind || "latex",
  };
}

/** JSON create: `{title, kind?: "latex"|"text", content, makePrimary?, targetJob?}` → `{resume, created}`. */
export async function createResume({ title, name, kind, content, makePrimary, targetJob } = {}) {
  const body = { content };
  const resumeTitle = title ?? name;
  if (resumeTitle) body.title = resumeTitle;
  if (kind) body.kind = kind;
  if (makePrimary !== undefined) body.makePrimary = Boolean(makePrimary);
  if (targetJob) body.targetJob = targetJob;
  const data = await http.post("/resumes", body);
  return { resume: normalizeResume(data?.resume), created: data?.created !== false };
}

/** Multipart create from a PDF / DOCX / TeX / TXT file → `{resume, created}`. */
export async function uploadResumeFile(file, { title, makePrimary } = {}) {
  const form = new FormData();
  form.append("file", file);
  if (title) form.append("title", title);
  if (makePrimary !== undefined) form.append("makePrimary", makePrimary ? "true" : "false");
  const data = await http.post("/resumes", form, { timeout: UPLOAD_TIMEOUT_MS });
  return { resume: normalizeResume(data?.resume), created: data?.created !== false };
}

/** `{title?, content?, targetJob?, expectedRevision?}` → ResumeSummary. 409 REVISION_CONFLICT on a stale revision. */
export async function updateResume(resumeId, { title, name, content, targetJob, expectedRevision } = {}) {
  const body = {};
  const resumeTitle = title ?? name;
  if (resumeTitle !== undefined) body.title = resumeTitle;
  if (content !== undefined) body.content = content;
  if (targetJob !== undefined) body.targetJob = targetJob;
  if (Number.isInteger(expectedRevision)) body.expectedRevision = expectedRevision;
  const data = await http.put(`/resumes/${id(resumeId)}`, body);
  return normalizeResume(data?.resume ?? data);
}

/** `{deleted, archived, primaryId}` — locked (shared/submitted) resumes are archived instead. */
export async function deleteResume(resumeId) {
  const data = await http.delete(`/resumes/${id(resumeId)}`);
  return { deleted: Boolean(data?.deleted), archived: Boolean(data?.archived), primaryId: data?.primaryId ?? null };
}

export async function restoreResume(resumeId) {
  const data = await http.post(`/resumes/${id(resumeId)}/restore`);
  return normalizeResume(data?.resume ?? data);
}

/** Make a resume the primary one → `{resume, previousPrimaryId}`. */
export async function setPrimaryResume(resumeId) {
  const data = await http.post(`/resumes/${id(resumeId)}/primary`);
  return { resume: normalizeResume(data?.resume), previousPrimaryId: data?.previousPrimaryId ?? null };
}

/** @deprecated name from FRONTEND.md §14.7 — same as setPrimaryResume. */
export const activateResume = setPrimaryResume;

export async function duplicateResume(resumeId, { title, name } = {}) {
  const body = {};
  if (title ?? name) body.title = title ?? name;
  const data = await http.post(`/resumes/${id(resumeId)}/duplicate`, body);
  return normalizeResume(data?.resume ?? data);
}

/**
 * POST /resumes/:id/apply-patches → `{resume, applied: string[], skipped: [{id, reason}]}`.
 * `mode`: "new-version" (default, creates a tailored copy) | "in-place".
 * 422 NO_PATCHES_APPLIED when nothing could be applied (`error.details.skipped`).
 */
export async function applyResumePatches(resumeId, { patches, mode = "new-version", title, targetJob, makePrimary, baseSourceHash } = {}) {
  const body = {
    patches: (Array.isArray(patches) ? patches : []).map((patch) => ({
      id: patch.id,
      charRange: patch.charRange,
      originalSubstring: patch.originalSubstring,
      replacementSubstring: patch.replacementSubstring,
    })),
    mode,
  };
  if (title) body.title = title;
  if (targetJob) body.targetJob = targetJob;
  if (makePrimary !== undefined) body.makePrimary = Boolean(makePrimary);
  if (baseSourceHash) body.baseSourceHash = baseSourceHash;
  const data = await http.post(`/resumes/${id(resumeId)}/apply-patches`, body);
  return {
    resume: normalizeResume(data?.resume),
    applied: Array.isArray(data?.applied) ? data.applied.map(String) : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
  };
}

/** Temporary signed link `{url, expiresAt, variant}` (variant: pdf | original). */
export async function getResumeAccess(resumeId, { variant } = {}) {
  const data = await http.get(`/resumes/${id(resumeId)}/access`, { params: variant ? { variant } : {} });
  return { url: data?.url ?? null, expiresAt: data?.expiresAt ?? null, variant: data?.variant ?? variant ?? null };
}

// ── binary helpers (compile + files) ───────────────────────────────────────

const headerOf = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) ?? null;
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
};

const isBlob = (value) => typeof Blob !== "undefined" && value instanceof Blob;

const readText = async (blob) => {
  try {
    return isBlob(blob) ? await blob.text() : String(blob ?? "");
  } catch {
    return "";
  }
};

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/** Turn a non-PDF Blob body (a JSON error envelope) into an ApiClientError. */
const blobError = async (blob, status, fallbackCode) => {
  const text = await readText(blob);
  const parsed = parseJson(text);
  const first = Array.isArray(parsed?.errors) ? parsed.errors[0] : null;
  return new ApiClientError({
    status: status || 422,
    code: (first && typeof first === "object" && first.code) || fallbackCode,
    message: parsed?.message || text.slice(0, 2000) || "The file could not be produced",
    details: first && typeof first === "object" ? first : null,
  });
};

/** Request a binary body; resolves `{blob, headers, status}`; error bodies become ApiClientError. */
const requestBlob = async (config, { expectType, fallbackCode }) => {
  const meta = { headers: null, status: 0 };
  const blob = await http.request({
    ...config,
    responseType: "blob",
    // 401 still goes through the refresh interceptor; everything else resolves so the body can be read.
    validateStatus: (status) => status !== 401,
    transformResponse: [
      (data, headers, status) => {
        meta.headers = headers;
        meta.status = status;
        return data;
      },
    ],
  });
  const type = String(blob?.type || headerOf(meta.headers, "content-type") || "");
  const ok = meta.status >= 200 && meta.status < 300;
  if (!ok || (expectType && !type.includes(expectType))) throw await blobError(blob, ok ? 422 : meta.status, fallbackCode);
  return { blob, headers: meta.headers, status: meta.status };
};

/**
 * Compile LaTeX to a PDF. `source` is the LaTeX string, or `{resumeId}` to compile
 * (and cache) a saved resume. Resolves `{blob, texErrors, ms}`; compile failures
 * throw ApiClientError (code LATEX_COMPILE_FAILED / LATEX_FORBIDDEN / COMPILER_BUSY …,
 * `details.log` holds the compiler log).
 */
export async function compileLatex(source) {
  const body = source && typeof source === "object" ? { resumeId: source.resumeId } : { latex: String(source ?? "") };
  const { blob, headers } = await requestBlob(
    { method: "post", url: "/resumes/compile", data: body, timeout: COMPILE_TIMEOUT_MS },
    { expectType: "application/pdf", fallbackCode: "COMPILE_FAILED" },
  );
  const texErrors = Number(headerOf(headers, "x-latex-errors"));
  const ms = Number(headerOf(headers, "x-compile-ms"));
  return { blob, texErrors: Number.isFinite(texErrors) ? texErrors : 0, ms: Number.isFinite(ms) ? ms : null };
}

/** Owner download of a stored file (variant pdf | original) as a Blob. */
export async function fetchResumeFile(resumeId, { variant = "pdf" } = {}) {
  const { blob } = await requestBlob(
    { method: "get", url: `/resumes/${id(resumeId)}/file`, params: { variant }, timeout: UPLOAD_TIMEOUT_MS },
    { expectType: variant === "pdf" ? "application/pdf" : null, fallbackCode: "FILE_FAILED" },
  );
  return blob;
}

// ── scoring (deterministic ATS) ────────────────────────────────────────────

const jobQuery = ({ jobId, jobSource } = {}) => {
  const params = {};
  if (jobId) params.jobId = jobId;
  if (jobId && jobSource) params.jobSource = jobSource;
  return params;
};

/**
 * ScoreResult for a resume (default: the primary one), optionally against a job.
 * Resolves `null` when the student has no active resume.
 */
export async function scoreResume({ resumeId, jobId, jobSource } = {}) {
  const params = jobQuery({ jobId, jobSource });
  if (resumeId) return (await http.get(`/resumes/${id(resumeId)}/score`, { params })) ?? null;
  return (await http.get("/resume/score", { params })) ?? null;
}

/** Legacy upload + score (multipart field `resume` or a `text` field) → ScoreResult & {created}. */
export async function uploadAndScoreResume({ file, text, title, makePrimary, jobId, jobSource } = {}) {
  const form = new FormData();
  if (file) form.append("resume", file);
  if (text) form.append("text", text);
  if (title) form.append("title", title);
  if (makePrimary !== undefined) form.append("makePrimary", makePrimary ? "true" : "false");
  if (jobId) {
    form.append("jobId", jobId);
    if (jobSource) form.append("jobSource", jobSource);
  }
  return http.post("/resume/upload", form, { timeout: UPLOAD_TIMEOUT_MS });
}

/** Score pasted text without storing anything → ScoreResult (resume: null). */
export async function previewResumeScore({ text, jobId, jobSource } = {}) {
  return http.post("/resume/score/preview", { text, ...jobQuery({ jobId, jobSource }) });
}

// ── resume bank (generated PDFs) ───────────────────────────────────────────

export async function listBankResumes() {
  const data = await http.get("/resume-bank");
  return Array.isArray(data) ? data : [];
}

/** Save generator LaTeX to the bank → BankItem & {pdfStatus}. */
export async function saveGeneratedResume({ latexCode, title, targetJob } = {}) {
  return http.post("/resume-bank/generated", { latexCode, title, targetJob: targetJob || null }, { timeout: 120000 });
}

/** Signed URL for a bank resume (owner, or an alumnus it was shared with). */
export async function getBankResumeUrl(bankResumeId, { variant } = {}) {
  const data = await http.get(`/resume-bank/${id(bankResumeId)}/access`, { params: variant ? { variant } : {} });
  return data?.url ?? null;
}

// ── jobs for the tailor / ATS / skill-gap pickers (read-only) ──────────────

const companyName = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.name || "");
};

const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : []);

/** Picker job `{id, source, title, company, description, skills, matchedSkills, missingSkills, ...}`. */
export const normalizePickerJob = (raw, source) => {
  if (!raw || typeof raw !== "object") return null;
  const jobId = raw.id ?? raw._id;
  if (!jobId) return null;
  return {
    id: String(jobId),
    source: source === "market" ? "market" : "campus",
    title: raw.title || raw.roleTitle || "Untitled role",
    company: raw.companyName || companyName(raw.company),
    description: typeof raw.description === "string" ? raw.description : "",
    location: raw.location || "",
    skills: stringList(raw.skills ?? raw.skillsRequired),
    matchedSkills: stringList(raw.matchedSkills),
    missingSkills: stringList(raw.missingSkills),
    matchPercentage: Number.isFinite(raw.matchPercentage) ? raw.matchPercentage : Number.isFinite(raw.matchScore) ? raw.matchScore : null,
    categories: stringList(raw.categories),
    status: raw.status ?? null,
  };
};

/** Campus drives visible to the student (GET /jobs). */
export async function listCampusJobsForResume({ limit = 100 } = {}) {
  const data = await http.get("/jobs", { params: { limit } });
  const items = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  return items.map((job) => normalizePickerJob(job, "campus")).filter(Boolean);
}

/** Market (job feed) jobs (GET /job-feed). */
export async function listMarketJobsForResume({ q, limit = 50 } = {}) {
  const params = { limit };
  if (q) params.q = q;
  const data = await http.get("/job-feed", { params });
  const items = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  return items.map((job) => normalizePickerJob(job, "market")).filter(Boolean);
}
