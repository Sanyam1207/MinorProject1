// Job references and job descriptions (docs/contracts/RESUME-BYOK.md §7).
//
// Campus drives are the placements `Job` model; market jobs are job-feed's
// `ExternalJob`. Both are reached LAZILY at call time (mongoose.models + dynamic
// imports) so this module never depends on the other areas' wiring, and this
// area NEVER writes either collection. Pasted job descriptions are stored per
// (user, job) in JobDescriptionOverride — never on the shared job document.
import crypto from "node:crypto";
import mongoose from "mongoose";
import { escapeRegex, fail, isObjectId } from "../../../core/http.js";
import { JD_MAX_CHARS, JD_MIN_CHARS, JobDescriptionOverride } from "../models/job-description-override.model.js";

const JOB_SOURCES = Object.freeze(["campus", "market"]);
const STOPWORDS = new Set(["at", "for", "in", "the", "of", "and", "with", "to", "job", "role", "drive"]);

const notFound = (message = "Job not found") => fail(404, message, "NOT_FOUND", { entity: "job" });

/** "campus" → campus; "market" | "external" → market; undefined → undefined; else 400. */
export const normalizeJobSource = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "campus") return "campus";
    if (normalized === "market" || normalized === "external") return "market";
    throw fail(400, "jobSource must be campus or market", "VALIDATION", { field: "jobSource" });
};

/** `{jobSource|jobKind, jobId}` from a query string or body (jobKind is an alias). */
export const jobParams = (input = {}) => ({
    jobId: input.jobId === undefined || input.jobId === null || input.jobId === "" ? undefined : String(input.jobId).trim(),
    jobSource: normalizeJobSource(input.jobSource ?? input.jobKind),
});

// ── lazy cross-module access ────────────────────────────────────────────────

const lazy = (loader, label) => {
    let promise = null;
    return () => {
        promise ||= loader().catch((error) => {
            if (error?.code !== "ERR_MODULE_NOT_FOUND") {
                console.warn(`[resume-lab] ${label} could not be loaded: ${error?.message || error}`);
            }
            return null;
        });
        return promise;
    };
};

const loadScopeModule = lazy(() => import("../../placements/services/scope.js"), "placements scope");
const loadFeedService = lazy(() => import("../../job-feed/feed.service.js"), "job-feed feed service");

/** Visibility filter for campus drives (placements jobScope, else the student rule). */
const campusScope = async (user) => {
    const scopeModule = await loadScopeModule();
    let appliedJobIds = [];
    const Application = mongoose.models.Application;
    if (user?.role === "student" && Application?.schema?.path("job") && Application.schema.path("student")) {
        appliedJobIds = await Application.distinct("job", { student: user._id }).catch(() => []);
    }
    if (typeof scopeModule?.jobScope === "function") {
        const scope = await scopeModule.jobScope(user, { appliedJobIds });
        return scope && typeof scope === "object" ? scope : {};
    }
    const college = user?.college ? { college: { $in: [user.college, null] } } : { college: null };
    if (user?.role === "student") {
        return {
            ...college,
            $or: [{ status: "active" }, ...(appliedJobIds.length ? [{ _id: { $in: appliedJobIds }, status: "closed" }] : [])],
        };
    }
    if (["tpo", "admin"].includes(user?.role)) return user.role === "admin" ? {} : college;
    return { ...college, status: "active" };
};

const companyName = (job) => {
    if (job?.company && typeof job.company === "object" && !isObjectId(job.company)) return String(job.company.name || "");
    if (typeof job?.company === "string" && !isObjectId(job.company)) return job.company;
    return String(job?.companyName || "");
};

const campusRef = (job) => ({
    source: "campus",
    id: String(job._id),
    title: String(job.title || ""),
    company: companyName(job),
    description: typeof job.description === "string" ? job.description : "",
    skills: Array.isArray(job.skills) ? job.skills.map(String).filter(Boolean) : [],
    location: job.location || null,
    applyUrl: job.applicationUrl ?? null,
});

const marketRef = (job) => ({
    source: "market",
    id: String(job.id ?? job._id),
    title: String(job.title || ""),
    company: typeof job.company === "string" ? job.company : String(job.company?.name || ""),
    description: typeof job.description === "string" ? job.description : "",
    skills: Array.isArray(job.skills) ? job.skills.map(String).filter(Boolean) : [],
    location: job.location || null,
    applyUrl: job.applyUrl ?? null,
});

const populateCompany = (query) => (mongoose.models.Company ? query.populate("company", "name") : query);

const findCampusJob = async (jobId, user) => {
    const Job = mongoose.models.Job;
    if (!Job) return null;
    const scope = await campusScope(user);
    const job = await populateCompany(Job.findOne({ $and: [{ _id: jobId }, scope] })).lean();
    return job ? campusRef(job) : null;
};

const findMarketJob = async (jobId) => {
    const feed = await loadFeedService();
    if (typeof feed?.getExternalJob === "function") {
        const job = await feed.getExternalJob(jobId);
        return job ? marketRef(job) : null;
    }
    const ExternalJob = mongoose.models.ExternalJob;
    if (!ExternalJob) return null;
    const job = await ExternalJob.findById(jobId).lean();
    return job ? marketRef(job) : null;
};

/** Resolve `{jobSource?, jobId}` to a JobRef within the user's visibility (404 otherwise). */
export const resolveJob = async ({ jobSource, jobId } = {}, { user } = {}) => {
    if (!isObjectId(String(jobId ?? ""))) throw fail(400, "jobId must be a valid id", "VALIDATION", { field: "jobId" });
    const source = normalizeJobSource(jobSource);
    const id = String(jobId);
    let job = null;
    if (source !== "market") job = await findCampusJob(id, user);
    if (!job && source !== "campus") job = await findMarketJob(id);
    if (!job) throw notFound();
    return job;
};

/** `{source, id, title, company}` — the job object used in responses. */
export const publicJob = (job) => (job ? { source: job.source, id: job.id, title: job.title, company: job.company } : null);

// ── free-text resolution ────────────────────────────────────────────────────

const textTokens = (text) => {
    const tokens = String(text).split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 2);
    const meaningful = tokens.filter((token) => !STOPWORDS.has(token.toLowerCase()));
    return (meaningful.length ? meaningful : tokens).slice(0, 6);
};

const searchCampus = async (text, user) => {
    const Job = mongoose.models.Job;
    if (!Job) return [];
    const tokens = textTokens(text);
    if (!tokens.length) return [];
    const Company = mongoose.models.Company;
    const clauses = [];
    for (const token of tokens) {
        const pattern = new RegExp(escapeRegex(token), "i");
        const alternatives = [{ title: pattern }, { companyName: pattern }];
        if (Company) {
            const companies = await Company.find({ name: pattern }).limit(200).select("_id").lean();
            if (companies.length) alternatives.push({ company: { $in: companies.map((company) => company._id) } });
        }
        clauses.push({ $or: alternatives });
    }
    const scope = await campusScope(user);
    const jobs = await populateCompany(Job.find({ $and: [scope, ...clauses] }).sort({ createdAt: -1 }).limit(10)).lean();
    jobs.sort((left, right) => Number(right.status === "active") - Number(left.status === "active"));
    return jobs.map(campusRef);
};

const searchMarketFallback = async (text) => {
    const ExternalJob = mongoose.models.ExternalJob;
    if (!ExternalJob) return { jobs: [] };
    const tokens = textTokens(text);
    if (!tokens.length) return { jobs: [] };
    const clauses = tokens.map((token) => {
        const pattern = new RegExp(escapeRegex(token), "i");
        return { $or: [{ title: pattern }, { company: pattern }] };
    });
    const recent = await ExternalJob.find({}).sort({ postedAt: -1, _id: -1 }).limit(500).select("_id").lean();
    const jobs = await ExternalJob.find({ $and: [{ _id: { $in: recent.map((job) => job._id) } }, ...clauses] })
        .sort({ postedAt: -1, _id: -1 }).limit(6).lean();
    return { jobs: jobs.map(marketRef) };
};

/** Market outcome for free text: {job} | {ambiguous, candidates} | {jobs: []} (no match). */
const searchMarket = async (text, user) => {
    const feed = await loadFeedService();
    if (typeof feed?.resolveMarketJob !== "function") {
        const { jobs } = await searchMarketFallback(text);
        if (jobs.length === 1) return { job: jobs[0] };
        if (jobs.length > 1) {
            return {
                ambiguous: true,
                candidates: jobs.slice(0, 5).map((job) => ({ id: `market:${job.id}`, label: `${job.title} · ${job.company} (market job)` })),
            };
        }
        return { jobs: [] };
    }
    try {
        const outcome = await feed.resolveMarketJob(text, { user });
        if (outcome?.ambiguous) {
            return {
                ambiguous: true,
                candidates: (outcome.candidates || []).map((candidate) => ({
                    id: String(candidate.id).startsWith("market:") ? String(candidate.id) : `market:${candidate.id}`,
                    label: String(candidate.label || "").includes("(market job)") ? candidate.label : `${candidate.label} (market job)`,
                })),
            };
        }
        if (outcome && (outcome.id || outcome._id)) return { job: marketRef(outcome) };
        if (outcome?.job) return { job: marketRef(outcome.job) };
        return { jobs: [] };
    } catch (error) {
        if (error?.statusCode === 404) return { jobs: [] };
        throw error;
    }
};

const campusLabel = (job) => `${job.title} · ${job.company} (campus drive)`;

/**
 * Resolve a fuzzy job reference (agent tools).
 * @returns {Promise<JobRef | {ambiguous: true, message, candidates: [{id, label}]}>}
 */
export const resolveJobRef = async (ref, { user } = {}) => {
    if (ref && typeof ref === "object") {
        const jobId = ref.jobId ?? ref.id;
        return resolveJob({ jobSource: ref.jobSource ?? ref.source ?? ref.kind, jobId }, { user });
    }
    const text = String(ref ?? "").trim();
    const prefixed = /^(campus|market|external):([a-f\d]{24})$/i.exec(text);
    if (prefixed) return resolveJob({ jobSource: prefixed[1], jobId: prefixed[2] }, { user });
    if (isObjectId(text)) return resolveJob({ jobId: text }, { user });
    if (text.length < 2 || text.length > 200) {
        throw fail(400, "Give a job id or a job title/company (2–200 characters)", "VALIDATION", { field: "job" });
    }

    const campus = await searchCampus(text, user);
    const market = await searchMarket(text, user);
    const marketHasJob = Boolean(market.job);
    const marketCandidates = market.ambiguous ? market.candidates : marketHasJob
        ? [{ id: `market:${market.job.id}`, label: `${market.job.title} · ${market.job.company} (market job)` }]
        : [];

    if (campus.length === 1 && !marketHasJob && !market.ambiguous) return campus[0];
    if (campus.length === 0) {
        if (marketHasJob) return market.job;
        if (market.ambiguous) {
            return { ambiguous: true, message: `Several jobs match '${text}'. Which one?`, candidates: marketCandidates.slice(0, 5) };
        }
        throw notFound(`No job matches '${text}'`);
    }
    const candidates = [
        ...campus.map((job) => ({ id: `campus:${job.id}`, label: campusLabel(job) })),
        ...marketCandidates,
    ].slice(0, 5);
    return { ambiguous: true, message: `Several jobs match '${text}'. Which one?`, candidates };
};

// ── job descriptions ────────────────────────────────────────────────────────

const textHash = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** Validate pasted JD text: null when absent, else trimmed text (400 on bad length). */
export const cleanManualJd = (manualText) => {
    if (manualText === undefined || manualText === null) return null;
    if (typeof manualText !== "string") throw fail(400, "The job description must be text", "VALIDATION", { field: "manualJobDescription" });
    const text = manualText.trim();
    if (!text) return null;
    if (text.length < JD_MIN_CHARS) {
        throw fail(400, "Paste the full job description (at least 30 characters)", "VALIDATION", { field: "manualJobDescription" });
    }
    if (text.length > JD_MAX_CHARS) {
        throw fail(400, `The job description is too long (at most ${JD_MAX_CHARS} characters)`, "VALIDATION", { field: "manualJobDescription" });
    }
    return text;
};

export const saveJobDescription = async (user, job, text) => {
    const doc = await JobDescriptionOverride.findOneAndUpdate(
        { user: user._id, jobSource: job.source, jobId: job.id },
        { $set: { text, textHash: textHash(text) } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    return doc;
};

export const getSavedJobDescription = (user, job) =>
    JobDescriptionOverride.findOne({ user: user._id, jobSource: job.source, jobId: job.id }).lean();

export const deleteSavedJobDescription = async (user, jobSource, jobId) => {
    const result = await JobDescriptionOverride.deleteOne({ user: user._id, jobSource, jobId });
    return result.deletedCount || 0;
};

/**
 * Pick the job description: pasted text (saved per user unless save=false) →
 * the user's saved text → the job's own description (≥ 30 chars) → null.
 * Shared job documents are NEVER modified.
 */
export const resolveJobDescription = async ({ user, job = null, manualText = null, save = true } = {}) => {
    const pasted = cleanManualJd(manualText);
    if (pasted) {
        if (job && save) await saveJobDescription(user, job, pasted);
        return { text: pasted, source: "request" };
    }
    if (job) {
        const saved = await getSavedJobDescription(user, job);
        if (saved?.text) return { text: saved.text, source: "saved", updatedAt: saved.updatedAt };
        const own = String(job.description || "").trim();
        if (own.length >= JD_MIN_CHARS) return { text: own, source: "job" };
    }
    return { text: null, source: null };
};

/** The JOB DESCRIPTION block sent to the LLM. */
export const jobContextBlock = (job, text) => {
    if (!job) return String(text ?? "");
    const lines = [`Title: ${job?.title || "(not given)"}`, `Company: ${job?.company || "(not given)"}`];
    if (Array.isArray(job?.skills) && job.skills.length) lines.push(`Key skills: ${job.skills.join(", ")}`);
    return `${lines.join("\n")}\n\n${text}`;
};

export { JOB_SOURCES };
