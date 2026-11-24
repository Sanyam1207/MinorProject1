// Reading the open-market feed: search, categories, sources, single jobs and
// free-text job references (docs/contracts/JOB-FEED.md §7, §10, §17).
// Nothing here ever calls a source: the API serves MongoDB at all times.
import { escapeRegex, fail, intParam, isObjectId } from "../../core/http.js";
import { getJobFeedConfig } from "./config.js";
import {
    ALL_SOURCES,
    JOB_TYPES,
    MATCH_CANDIDATE_WINDOW,
    SAMPLE_SOURCE,
    WHATSAPP_SOURCE,
    WORK_TYPES,
    locationVariants,
    sourceLabel,
} from "./constants.js";
import { buildProfileSignals, scoreExternalJob } from "./match.js";
import { ExternalJob } from "./models/external-job.model.js";
import { JobSyncRun } from "./models/job-sync-run.model.js";
import { SavedJob } from "./models/saved-job.model.js";
import { WhatsAppPost } from "./models/whatsapp-post.model.js";
import { normalizeJobType, normalizeWorkType } from "./normalizer.js";
import { jobRepository } from "./repository.js";
import { getWhatsAppStatus } from "./whatsapp/status.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_MAX = 100;
const QUERY_TOKENS_MAX = 6;
const FILTER_TEXT_MAX = 60;
const REF_MAX = 200;
const REF_TOKENS_MAX = 8;
const AMBIGUOUS_CANDIDATES_MAX = 5;
const SEARCH_FIELDS = ["title", "company", "location", "categories", "description"];
export const SORTS = Object.freeze(["newest", "match"]);
export const NEWEST_SORT = Object.freeze({ postedAt: -1, _id: -1 });

const isStudent = (user) => user?.role === "student";
const idOf = (value) => (value?._id ?? value)?.toString?.() ?? null;
const textParam = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

// ── Public shapes ───────────────────────────────────────────────────────────

/** The viewer's tracker state shown on a job card. */
export const toSavedState = (saved) => (saved
    ? {
        status: saved.status,
        notes: saved.notes ?? "",
        savedAt: saved.createdAt ?? null,
        appliedAt: saved.appliedAt ?? null,
    }
    : null);

/** Unique source names in first-seen order. */
const sourceNames = (sources) => [...new Set((Array.isArray(sources) ? sources : [])
    .map((source) => (typeof source === "string" ? source : source?.name))
    .filter(Boolean))];

/**
 * PublicExternalJob (JOB-FEED.md §7.1). `saved` is the viewer's SavedJob (or null);
 * `match` ({score, matchedSkills}) adds matchScore/matchedSkills when ranked.
 */
export const toPublicJob = (doc, { now = new Date(), saved = null, match = undefined } = {}) => {
    const job = typeof doc?.toObject === "function" ? doc.toObject() : doc;
    const postedAt = job.postedAt ? new Date(job.postedAt) : null;
    const publicJob = {
        id: idOf(job._id ?? job.id),
        kind: "external",
        title: job.title ?? null,
        company: job.company ?? null,
        companyLogo: job.companyLogo ?? null,
        location: job.location ?? null,
        experience: job.experience ?? null,
        salary: job.salary ?? null,
        jobType: job.jobType ?? null,
        workType: job.workType ?? null,
        applyUrl: job.applyUrl ?? null,
        description: job.description ?? null,
        postedAt: postedAt ?? null,
        lastSeenAt: job.lastSeenAt ?? null,
        createdAt: job.createdAt ?? null,
        sources: sourceNames(job.sources),
        categories: Array.isArray(job.categories) ? [...job.categories] : [],
        isSample: job.isSample === true,
        isNew: Boolean(postedAt) && now.getTime() - postedAt.getTime() <= DAY_MS,
        saved: toSavedState(saved),
    };
    if (match !== undefined) {
        publicJob.matchScore = match?.score ?? null;
        publicJob.matchedSkills = Array.isArray(match?.matchedSkills) ? match.matchedSkills : [];
    }
    return publicJob;
};

/** `“<title>” at <company>`, `“<title>”` without a company, `<company> role` without a title. */
export const jobLabel = (job) => {
    const title = job?.title || job?.snapshot?.title || null;
    const company = job?.company || job?.snapshot?.company || null;
    if (title && company) return `“${title}” at ${company}`;
    if (title) return `“${title}”`;
    if (company) return `${company} role`;
    return "this job";
};

/** "<Title> — <Company> (<Location>)" with missing parts left out. */
export const candidateLabel = (job) => {
    const title = job?.title || "Untitled role";
    const company = job?.company ? ` — ${job.company}` : "";
    const location = job?.location ? ` (${job.location})` : "";
    return `${title}${company}${location}`;
};

// ── Search ──────────────────────────────────────────────────────────────────

/** Whitespace tokens of at least 2 characters, at most `max`. */
export const searchTokens = (text, max = QUERY_TOKENS_MAX) =>
    String(text ?? "").split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 2).slice(0, max);

const locationFilter = (location) => {
    const variants = locationVariants(location);
    return variants.length ? new RegExp(variants.map(escapeRegex).join("|"), "i") : null;
};

/**
 * Validate list parameters and build the MongoDB filter.
 * Throws 400 VALIDATION for an unknown jobType / workType / sort.
 */
export const buildFeedQuery = (params = {}) => {
    const q = textParam(params.q).slice(0, QUERY_MAX).trim();
    const rawJobType = textParam(params.jobType);
    const rawWorkType = textParam(params.workType);
    const category = textParam(params.category).toLowerCase().slice(0, FILTER_TEXT_MAX).trim();
    const source = textParam(params.source).toLowerCase();
    const location = textParam(params.location).slice(0, FILTER_TEXT_MAX).trim();
    const rawSort = textParam(params.sort).toLowerCase();

    const jobType = rawJobType ? normalizeJobType(rawJobType) : null;
    if (rawJobType && !jobType) {
        throw fail(400, `Unknown job type. Use one of: ${JOB_TYPES.join(", ")}.`, "VALIDATION", { field: "jobType" });
    }
    const workType = rawWorkType ? normalizeWorkType(rawWorkType) : null;
    if (rawWorkType && !workType) {
        throw fail(400, `Unknown work type. Use one of: ${WORK_TYPES.join(", ")}.`, "VALIDATION", { field: "workType" });
    }
    const sort = rawSort || "newest";
    if (!SORTS.includes(sort)) {
        throw fail(400, `Unknown sort. Use one of: ${SORTS.join(", ")}.`, "VALIDATION", { field: "sort" });
    }

    const and = [];
    for (const token of searchTokens(q)) {
        const pattern = new RegExp(escapeRegex(token), "i");
        and.push({ $or: SEARCH_FIELDS.map((field) => ({ [field]: pattern })) });
    }
    const filter = {};
    if (and.length) filter.$and = and;
    if (jobType) filter.jobType = jobType;
    if (workType) filter.workType = workType;
    if (category) filter.categories = category;
    if (source) filter["sources.name"] = source;
    if (location) filter.location = locationFilter(location);

    return {
        filter,
        filters: {
            q: q || null,
            jobType,
            workType,
            category: category || null,
            source: source || null,
            location: location || null,
            sort,
        },
    };
};

/** The viewer's SavedJob entries for these job ids, keyed by job id (students only; one query). */
const savedByJob = async (viewer, jobIds) => {
    if (!isStudent(viewer) || jobIds.length === 0) return new Map();
    const entries = await SavedJob.find({ user: viewer._id, job: { $in: jobIds } }).lean();
    return new Map(entries.map((entry) => [String(entry.job), entry]));
};

/**
 * List / search the open-market feed (GET /api/v1/job-feed and jobs_search_market).
 * @returns {Promise<{jobs: object[], page: number, limit: number, total: number, hasNextPage: boolean, filters: object}>}
 */
export const searchMarketJobs = async ({
    q, category, jobType, workType, location, source, sort, page, limit, viewer = null, now = new Date(),
} = {}) => {
    const { filter, filters } = buildFeedQuery({ q, category, jobType, workType, location, source, sort });
    const pageNumber = intParam(page, { min: 1, max: 1000, fallback: 1 });
    const pageSize = intParam(limit, { min: 1, max: 50, fallback: 20 });
    const skip = (pageNumber - 1) * pageSize;

    if (filters.sort === "match") {
        const signals = buildProfileSignals(viewer);
        const [candidates, total] = await Promise.all([
            jobRepository.list(filter, { skip: 0, limit: MATCH_CANDIDATE_WINDOW, sort: NEWEST_SORT }),
            jobRepository.count(filter),
        ]);
        const ranked = candidates
            .map((job, index) => ({ job, index, match: scoreExternalJob(job, signals, now) }))
            .sort((a, b) => {
                const scoreA = a.match.score ?? -1;
                const scoreB = b.match.score ?? -1;
                return scoreB - scoreA || a.index - b.index; // candidates are already newest first
            });
        const pageItems = ranked.slice(skip, skip + pageSize);
        const saved = await savedByJob(viewer, pageItems.map(({ job }) => job._id));
        return {
            jobs: pageItems.map(({ job, match }) => toPublicJob(job, { now, saved: saved.get(String(job._id)), match })),
            page: pageNumber,
            limit: pageSize,
            total,
            hasNextPage: pageNumber * pageSize < Math.min(total, MATCH_CANDIDATE_WINDOW),
            filters,
        };
    }

    const [docs, total] = await Promise.all([
        jobRepository.list(filter, { skip, limit: pageSize, sort: NEWEST_SORT }),
        jobRepository.count(filter),
    ]);
    const saved = await savedByJob(viewer, docs.map((doc) => doc._id));
    return {
        jobs: docs.map((doc) => toPublicJob(doc, { now, saved: saved.get(String(doc._id)) })),
        page: pageNumber,
        limit: pageSize,
        total,
        hasNextPage: pageNumber * pageSize < total,
        filters,
    };
};

export const listCategories = async () => ({ categories: await jobRepository.listCategories() });

// ── Single jobs ─────────────────────────────────────────────────────────────

/** PublicExternalJob for an id (no viewer state), or null when the id is invalid or unknown. */
export const getExternalJob = async (id, { now = new Date() } = {}) => {
    const value = idOf(id);
    if (!value || !isObjectId(value)) return null;
    const doc = await ExternalJob.findById(value).lean();
    return doc ? toPublicJob(doc, { now }) : null;
};

/** GET /:id — with the viewer's saved state (students) and fit score. Throws 400 / 404. */
export const getExternalJobForViewer = async (id, { viewer = null, now = new Date() } = {}) => {
    if (!isObjectId(String(id ?? ""))) throw fail(400, "id must be a valid job id", "VALIDATION", { field: "id" });
    const doc = await ExternalJob.findById(id).lean();
    if (!doc) throw fail(404, "This job is no longer in the feed.", "NOT_FOUND");
    const saved = await savedByJob(viewer, [doc._id]);
    return toPublicJob(doc, {
        now,
        saved: saved.get(String(doc._id)),
        match: scoreExternalJob(doc, buildProfileSignals(viewer), now),
    });
};

// ── Free-text job references (agent tools, resume tailoring) ────────────────

// "<title> at <company>" splits on the last " at ".
const splitTitleCompany = (text) => {
    const index = text.toLowerCase().lastIndexOf(" at ");
    if (index <= 0) return null;
    const title = text.slice(0, index).trim();
    const company = text.slice(index + 4).trim();
    return title && company ? { title, company } : null;
};

const tokenPatterns = (text) => searchTokens(text, REF_TOKENS_MAX).map((token) => new RegExp(escapeRegex(token), "i"));

/** Matchers for a reference: split title/company first, then the whole text against "title company". */
const refMatchers = (text) => {
    const matchers = [];
    const split = splitTitleCompany(text);
    if (split) {
        const titlePatterns = tokenPatterns(split.title);
        const companyPatterns = tokenPatterns(split.company);
        if (titlePatterns.length && companyPatterns.length) {
            matchers.push({
                exact: (job) => String(job.title ?? "").trim().toLowerCase() === split.title.toLowerCase()
                    && String(job.company ?? "").trim().toLowerCase() === split.company.toLowerCase(),
                test: (job) => titlePatterns.every((pattern) => pattern.test(job.title ?? ""))
                    && companyPatterns.every((pattern) => pattern.test(job.company ?? "")),
                query: {
                    $and: [
                        ...titlePatterns.map((pattern) => ({ title: pattern })),
                        ...companyPatterns.map((pattern) => ({ company: pattern })),
                    ],
                },
            });
        }
    }
    const patterns = tokenPatterns(text);
    if (patterns.length) {
        matchers.push({
            exact: (job) => String(job.title ?? "").trim().toLowerCase() === text.toLowerCase(),
            test: (job) => patterns.every((pattern) => pattern.test(`${job.title ?? ""} ${job.company ?? ""}`)),
            query: { $and: patterns.map((pattern) => ({ $or: [{ title: pattern }, { company: pattern }] })) },
        });
    }
    return matchers;
};

/** One hit → it; several with exactly one exact title(/company) match → that one; else all hits. */
const narrow = (hits, matcher) => {
    if (hits.length <= 1) return hits;
    const exact = hits.filter(matcher.exact);
    return exact.length === 1 ? exact : hits;
};

// A tracker entry whose job was purged still resolves, as a job built from its snapshot.
const snapshotJob = (entry) => ({
    _id: entry.job,
    title: entry.snapshot?.title ?? null,
    company: entry.snapshot?.company ?? null,
    location: entry.snapshot?.location ?? null,
    applyUrl: entry.snapshot?.applyUrl ?? null,
    jobType: entry.snapshot?.jobType ?? null,
    workType: entry.snapshot?.workType ?? null,
    salary: entry.snapshot?.salary ?? null,
    postedAt: entry.snapshot?.postedAt ?? null,
    sources: entry.snapshot?.sources ?? [],
    categories: [],
    isSample: false,
});

const ambiguous = (ref, jobs) => ({
    ambiguous: true,
    message: `Several jobs match '${ref}'. Which one?`,
    candidates: jobs
        .slice()
        .sort((a, b) => new Date(b.postedAt ?? 0) - new Date(a.postedAt ?? 0))
        .slice(0, AMBIGUOUS_CANDIDATES_MAX)
        .map((job) => ({ id: idOf(job._id), label: candidateLabel(job) })),
});

/**
 * Resolve a job id or "<title> at <company>" text to a PublicExternalJob (no viewer
 * state), or {ambiguous, message, candidates}. Throws 404 NOT_FOUND when nothing matches.
 * Text looks at the user's tracker first, then the newest matching feed jobs.
 */
export const resolveMarketJob = async (ref, { user = null, now = new Date() } = {}) => {
    const raw = typeof ref === "string" ? ref.trim() : idOf(ref) ?? "";
    if (isObjectId(raw)) {
        const doc = await ExternalJob.findById(raw).lean();
        if (doc) return toPublicJob(doc, { now });
        if (user?._id) {
            const entry = await SavedJob.findOne({ user: user._id, job: raw }).lean();
            if (entry) return toPublicJob(snapshotJob(entry), { now });
        }
        throw fail(404, `No open-market job has id ${raw}. Campus drives are applied to with drive_apply.`, "NOT_FOUND");
    }

    const text = raw.slice(0, REF_MAX).trim();
    const matchers = refMatchers(text);
    if (!text || matchers.length === 0) throw fail(404, `No open-market job matches '${text}'.`, "NOT_FOUND");

    if (user?._id) {
        const entries = await SavedJob.find({ user: user._id }).sort({ updatedAt: -1 }).lean();
        const tracked = entries.map(snapshotJob);
        for (const matcher of matchers) {
            const hits = narrow(tracked.filter(matcher.test), matcher);
            if (hits.length === 1) {
                const live = await ExternalJob.findById(hits[0]._id).lean();
                return toPublicJob(live || hits[0], { now });
            }
            if (hits.length > 1) return ambiguous(text, hits);
        }
    }

    for (const matcher of matchers) {
        const hits = narrow(
            await ExternalJob.find(matcher.query).sort(NEWEST_SORT).limit(MATCH_CANDIDATE_WINDOW).lean(),
            matcher,
        );
        if (hits.length === 1) return toPublicJob(hits[0], { now });
        if (hits.length > 1) return ambiguous(text, hits);
    }
    throw fail(404, `No open-market job matches '${text}'.`, "NOT_FOUND");
};

// ── Sources ─────────────────────────────────────────────────────────────────

const SOURCE_KINDS = Object.freeze({ debugwithshubham: "poll", artha: "poll", whatsapp: "push", sample: "seed" });

const lastRunWithoutError = async (name) => JobSyncRun.findOne({
    status: { $ne: "running" },
    results: { $elemMatch: { source: name, error: null } },
}).sort({ startedAt: -1 }).select("finishedAt").lean();

const lastRunIncluding = async (name) => JobSyncRun.findOne({
    status: { $ne: "running" },
    "results.source": name,
}).sort({ startedAt: -1 }).select("results").lean();

const whatsappSourceInfo = async (config, count) => {
    const status = getWhatsAppStatus();
    const [lastSaved, lastPost] = await Promise.all([
        WhatsAppPost.findOne({ status: "saved" }).sort({ updatedAt: -1 }).select("updatedAt").lean(),
        WhatsAppPost.findOne({}).sort({ updatedAt: -1 }).select("status error updatedAt").lean(),
    ]);
    let lastError = null;
    if (lastPost?.status === "failed") lastError = lastPost.error || "The post could not be processed.";
    else if (config.whatsappEnabled && status.state === "unavailable") lastError = status.reason;
    return {
        name: WHATSAPP_SOURCE,
        label: sourceLabel(WHATSAPP_SOURCE),
        kind: SOURCE_KINDS.whatsapp,
        enabled: config.whatsappEnabled && status.state !== "unavailable",
        count,
        lastSyncedAt: lastSaved?.updatedAt ?? null,
        lastError,
    };
};

/** SourceInfo[] for debugwithshubham, artha, whatsapp and sample (GET /sources, /sync/status). */
export const listSourceInfo = async ({ config = getJobFeedConfig() } = {}) => {
    const counts = await jobRepository.listSourceCounts();
    return Promise.all(ALL_SOURCES.map(async (name) => {
        const count = counts[name] ?? 0;
        if (name === WHATSAPP_SOURCE) return whatsappSourceInfo(config, count);
        if (name === SAMPLE_SOURCE) {
            return { name, label: sourceLabel(name), kind: SOURCE_KINDS[name], enabled: count > 0, count, lastSyncedAt: null, lastError: null };
        }
        const [ok, last] = await Promise.all([lastRunWithoutError(name), lastRunIncluding(name)]);
        const result = last?.results?.find((entry) => entry.source === name);
        return {
            name,
            label: sourceLabel(name),
            kind: SOURCE_KINDS[name],
            enabled: name === "artha" ? config.fromArtha : true,
            count,
            lastSyncedAt: ok?.finishedAt ?? null,
            lastError: result?.error ?? null,
        };
    }));
};

export const listSources = async (options) => ({ sources: await listSourceInfo(options) });
