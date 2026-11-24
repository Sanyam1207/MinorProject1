// Copilot tools of the job feed (docs/contracts/JOB-FEED.md §10, AGENT-TOOLS.md §5,
// UI-ACTIONS.md §10). Handlers run as ctx.user and reuse the feed / tracker services.
import { DateTime } from "luxon";
import { fail } from "../../core/http.js";
import { getJobFeedConfig } from "./config.js";
import { ALL_SOURCES, JOB_TYPES, WORK_TYPES, sourceLabel } from "./constants.js";
import { candidateLabel, jobLabel, resolveMarketJob, searchMarketJobs } from "./feed.service.js";
import { getPolledSources } from "./sources/index.js";
import { jobSyncService } from "./sync.service.js";
import { findSavedJob, upsertSavedJob } from "./tracker.service.js";

export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 20;
export const SYNC_TOOL_WAIT_MS = 15_000;
const SUMMARY_JOBS = 5;
const FINAL_STATUSES = new Set(["interviewing", "offer", "rejected"]);

const appTimezone = (ctx) => (ctx?.timezone || process.env.APP_TIMEZONE || "Asia/Kolkata").trim();

const zoned = (date, ctx) => {
    const value = DateTime.fromJSDate(date instanceof Date ? date : new Date(date));
    const inZone = value.setZone(appTimezone(ctx));
    return inZone.isValid ? inZone : value.setZone("UTC");
};

const requireUser = (ctx) => {
    if (!ctx?.user?._id) throw fail(401, "Sign in to use the job feed", "UNAUTHORIZED");
    return ctx.user;
};

const roleOf = (ctx) => ctx?.role || ctx?.user?.role || null;

const clampLimit = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return SEARCH_LIMIT_DEFAULT;
    return Math.min(SEARCH_LIMIT_MAX, Math.max(1, parsed));
};

const withoutNulls = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined && value !== ""));

const facetsText = (filters) => [
    filters.q ? ` for “${filters.q}”` : "",
    filters.jobType ? ` · ${filters.jobType}` : "",
    filters.workType ? ` · ${filters.workType}` : "",
    filters.location ? ` · ${filters.location}` : "",
    filters.category ? ` · ${filters.category}` : "",
    filters.source ? ` · ${sourceLabel(filters.source)}` : "",
].join("");

const searchSummary = ({ jobs, total, filters }) => {
    const facets = facetsText(filters);
    if (!total || !jobs.length) return `No open-market jobs match${facets}. Try fewer keywords or another location.`;
    const top = jobs.slice(0, SUMMARY_JOBS).map((job, index) => {
        const fit = typeof job.matchScore === "number" ? ` · ${job.matchScore}% fit` : "";
        return `${index + 1}) ${candidateLabel(job)}${fit}`;
    });
    return `Found ${total} open-market job${total === 1 ? "" : "s"}${facets}. Top matches: ${top.join("; ")}`;
};

/** Students land on the market panel; TPO/admin on the job-feed admin panel; other roles get no UI action. */
const searchUi = (role, filters, ids) => {
    const params = withoutNulls({
        query: filters.q,
        category: filters.category,
        jobType: filters.jobType,
        workType: filters.workType,
        location: filters.location,
        source: filters.source,
        sort: filters.sort,
    });
    if (role === "student") return { panel: "jobs.market", params: { ...params, ...(ids.length ? { highlightIds: ids } : {}) } };
    if (role === "tpo" || role === "admin") return { panel: "tpo.job-feed", params };
    return undefined;
};

/** Resolve the `job` argument; returns {ambiguous...} untouched for the executor. */
const resolveJobArg = async (args, ctx) => {
    const ref = typeof args?.job === "string" ? args.job.trim() : "";
    if (!ref) throw fail(400, "Name the job: an id from jobs_search_market or 'Title at Company'.", "VALIDATION", { field: "job" });
    return resolveMarketJob(ref, { user: ctx.user, now: ctx.now instanceof Date ? ctx.now : new Date() });
};

const notesArg = (args) => (typeof args?.notes === "string" && args.notes.trim() ? args.notes.trim() : undefined);

const enabledSourceLabels = () => {
    const sources = jobSyncService.sources ?? getPolledSources(getJobFeedConfig());
    const labels = [...new Set(sources.map((source) => sourceLabel(source?.name)).filter(Boolean))];
    return labels.length ? labels.join(" and ") : "the configured sources";
};

const withoutTrailingPeriod = (text) => String(text ?? "").trim().replace(/[.\s]+$/, "");

const syncFinishedSummary = (run) => {
    const verb = { ok: "finished", partial: "finished with errors", failed: "failed" }[run.status] || run.status;
    const seconds = ((run.durationMs ?? 0) / 1000).toFixed(1);
    const totals = run.totals || {};
    let summary = `Job feed sync ${verb} in ${seconds}s: ${totals.inserted ?? 0} new, ${totals.duplicates ?? 0} already known, ${totals.skipped ?? 0} skipped.`;
    for (const result of run.results || []) {
        if (result.error) summary += ` ${result.label || sourceLabel(result.source)} failed: ${withoutTrailingPeriod(result.error)}.`;
    }
    if (run.status === "failed" && run.error && !(run.results || []).some((result) => result.error)) {
        summary += ` ${withoutTrailingPeriod(run.error)}.`;
    }
    if (run.status === "failed") summary += " Existing jobs were kept.";
    return summary;
};

const TIMED_OUT = Symbol("timed-out");

export default [
    {
        name: "jobs_search_market",
        description:
            "Search the open-market job feed: jobs aggregated from external job boards (and WhatsApp job channels when enabled), "
            + "NOT the college's campus drives (use jobs_search_campus for those). Every word of `query` must appear in the job's "
            + "title, company, location, categories or description. Results are ranked by fit with the user's profile (sort "
            + "'match', the default for students) or newest first.",
        roles: ["student", "teacher", "tpo", "company", "admin", "alumni"],
        confirm: false,
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keywords, e.g. 'react developer' or 'data analyst'. Every word must match." },
                category: { type: "string", description: "Field of work, e.g. 'developer', 'data-analyst', 'design'." },
                jobType: { type: "string", enum: [...JOB_TYPES], description: "Employment type." },
                workType: { type: "string", enum: [...WORK_TYPES], description: "Onsite, remote or hybrid." },
                location: { type: "string", description: "City, e.g. 'Bengaluru' (Bangalore also works) or 'Remote'." },
                source: { type: "string", enum: [...ALL_SOURCES], description: "Only jobs reported by this source." },
                sort: { type: "string", enum: ["match", "newest"], description: "'match' ranks by profile fit; 'newest' by posting date." },
                limit: { type: "integer", description: `How many jobs to return, 1-${SEARCH_LIMIT_MAX}. Default ${SEARCH_LIMIT_DEFAULT}.` },
            },
            required: [],
        },
        handler: async (args = {}, ctx = {}) => {
            const user = requireUser(ctx);
            const role = roleOf(ctx);
            const result = await searchMarketJobs({
                q: args.query,
                category: args.category,
                jobType: args.jobType,
                workType: args.workType,
                location: args.location,
                source: args.source,
                sort: args.sort || (role === "student" ? "match" : "newest"),
                page: 1,
                limit: clampLimit(args.limit),
                viewer: user,
                now: ctx.now instanceof Date ? ctx.now : new Date(),
            });
            const ids = result.jobs.map((job) => job.id);
            return {
                summary: searchSummary(result),
                data: { jobs: result.jobs, total: result.total, filters: result.filters },
                ui: searchUi(role, result.filters, ids),
            };
        },
    },
    {
        name: "market_job_save",
        description:
            "Save an open-market job to the student's job tracker with status 'saved'. `job` is a job id from jobs_search_market "
            + "results, or its title and company, e.g. 'Data Analyst Intern at Northwind Analytics'. Campus drives cannot be saved; "
            + "students apply to them with drive_apply.",
        roles: ["student"],
        confirm: false,
        parameters: {
            type: "object",
            properties: {
                job: { type: "string", description: "Job id from jobs_search_market, or 'Title at Company'." },
                notes: { type: "string", description: "Optional note to keep with the saved job." },
            },
            required: ["job"],
        },
        handler: async (args = {}, ctx = {}) => {
            const user = requireUser(ctx);
            const job = await resolveJobArg(args, ctx);
            if (job?.ambiguous) return job;
            const now = ctx.now instanceof Date ? ctx.now : new Date();
            const existing = await findSavedJob({ user, jobId: job.id });
            const { item, created } = await upsertSavedJob({
                user,
                jobId: job.id,
                status: existing ? undefined : "saved",
                notes: notesArg(args),
                now,
            });
            const label = jobLabel(item.job || item.snapshot);
            return {
                summary: created
                    ? `Saved ${label} to your job tracker.`
                    : `${label} is already in your tracker (${item.status}).`,
                data: { item, created },
                ui: { panel: "jobs.tracker", params: { highlightId: item.jobId } },
            };
        },
    },
    {
        name: "market_job_mark_applied",
        description:
            "Mark an open-market job as applied in the student's job tracker (adds it if needed). Use after the student says they "
            + "applied on the company's site. `job`: id or 'title at company'.",
        roles: ["student"],
        confirm: false,
        parameters: {
            type: "object",
            properties: {
                job: { type: "string", description: "Job id from jobs_search_market, or 'Title at Company'." },
                notes: { type: "string", description: "Optional note, e.g. where or how they applied." },
            },
            required: ["job"],
        },
        handler: async (args = {}, ctx = {}) => {
            const user = requireUser(ctx);
            const job = await resolveJobArg(args, ctx);
            if (job?.ambiguous) return job;
            const now = ctx.now instanceof Date ? ctx.now : new Date();
            const existing = await findSavedJob({ user, jobId: job.id });
            const previousStatus = existing?.status ?? null;
            const keep = FINAL_STATUSES.has(previousStatus);
            const { item, created } = await upsertSavedJob({
                user,
                jobId: job.id,
                status: keep ? undefined : "applied",
                notes: notesArg(args),
                now,
            });
            const label = jobLabel(item.job || item.snapshot);
            const appliedOn = zoned(item.appliedAt || now, ctx).toFormat("d LLL");
            return {
                summary: keep
                    ? `${label} is already marked as ${item.status}.`
                    : `Marked ${label} as applied on ${appliedOn}. Good luck!`,
                data: { item, created, previousStatus },
                ui: { panel: "jobs.tracker", params: { status: "applied", highlightId: item.jobId } },
            };
        },
    },
    {
        name: "job_feed_sync",
        description:
            "Fetch the latest jobs from the external sources into the open-market feed now (it also runs automatically every hour). "
            + "TPO/admin only.",
        roles: ["tpo", "admin"],
        confirm: true,
        parameters: { type: "object", properties: {}, required: [] },
        preview: async (_args = {}, ctx = {}) => {
            let summary = `Fetch the latest jobs now from ${enabledSourceLabels()}? It usually takes under a minute; existing jobs are kept if a source is down.`;
            const running = jobSyncService.current();
            if (running) {
                summary += ` A sync is already running (started ${zoned(running.startedAt, ctx).toFormat("HH:mm")}); confirming will wait for it.`;
            }
            return { summary, args: {} };
        },
        handler: async (_args = {}, ctx = {}) => {
            const user = requireUser(ctx);
            const promise = jobSyncService.sync({ trigger: "agent", triggeredBy: user });
            let timer = null;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve(TIMED_OUT), SYNC_TOOL_WAIT_MS);
                timer.unref?.();
            });
            let outcome;
            try {
                outcome = await Promise.race([promise, timeout]);
            } finally {
                clearTimeout(timer);
            }
            if (outcome === TIMED_OUT) {
                promise.catch(() => {});
                const run = jobSyncService.current();
                const started = run?.startedAt ? zoned(run.startedAt, ctx).toFormat("HH:mm") : zoned(new Date(), ctx).toFormat("HH:mm");
                return {
                    summary: `The sync is running (started ${started}); results will appear in the Job feed panel when it finishes.`,
                    data: { run, finished: false },
                    ui: { panel: "tpo.job-feed", params: run?.id ? { runId: run.id } : {} },
                };
            }
            return {
                summary: syncFinishedSummary(outcome),
                data: { run: outcome, finished: true },
                ui: { panel: "tpo.job-feed", params: { runId: outcome.id } },
            };
        },
    },
];
