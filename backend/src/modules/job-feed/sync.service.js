// Pulls jobs from the polled sources into ExternalJob (docs/contracts/JOB-FEED.md §5).
// Ported from Matchy's job-sync.service.js with run persistence (JobSyncRun),
// single-flight runs whose state is visible while they run, sample cleanup and
// post-run hooks (socket events, notifications). The scheduler lives in index.js.
//
// Offline behaviour: when every source fails the run ends "failed", nothing is
// deleted or modified, the run is persisted with each source's error and the
// promise resolves (never rejects); the next scheduled tick retries.
import mongoose from "mongoose";
import { getIO, rooms } from "../../core/realtime.js";
import { getJobFeedConfig } from "./config.js";
import { SAMPLE_SOURCE, sourceLabel } from "./constants.js";
import { ExternalJob } from "./models/external-job.model.js";
import { JobSyncRun } from "./models/job-sync-run.model.js";
import { SavedJob } from "./models/saved-job.model.js";
import { normalizeJob } from "./normalizer.js";
import { notifyMatchDigest, notifySyncFailure } from "./notify.js";
import { JobRepository } from "./repository.js";
import { getPolledSources } from "./sources/index.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// When the interval is 0 (no periodic sync), a boot sync still waits this long after the last success.
const BOOT_SYNC_FALLBACK_MINUTES = 60;
// A failed boot/scheduled attempt is not repeated by a restart within this window (dev --watch restarts).
export const FAILED_BOOT_RETRY_MINUTES = 10;
export const INTERRUPTED_RUN_ERROR = "Interrupted by a server restart";

const isTest = () => process.env.NODE_ENV === "test";

/** Console logger that stays quiet under NODE_ENV=test (set JOB_FEED_LOG=true to see it). */
export const defaultLogger = {
    log: (...args) => {
        if (!isTest() || process.env.JOB_FEED_LOG === "true") console.log(...args);
    },
    warn: (...args) => {
        if (!isTest() || process.env.JOB_FEED_LOG === "true") console.warn(...args);
    },
    error: (...args) => {
        if (!isTest() || process.env.JOB_FEED_LOG === "true") console.error(...args);
    },
};

const emptyTotals = () => ({ received: 0, inserted: 0, duplicates: 0, skipped: 0 });

const toDate = (value) => (value ? new Date(value) : null);

/** `job-feed:*` events go to every socket in any of these role rooms (once per socket). */
export const emitToRoles = (roles, event, payload) => {
    const io = getIO();
    if (!io) return false;
    io.to(roles.map((role) => rooms.role(role))).emit(event, payload);
    return true;
};

const triggeredByOf = (value) => {
    if (!value) return null;
    if (typeof value === "object" && value._id) {
        return { id: String(value._id), name: typeof value.name === "string" ? value.name : null };
    }
    const id = String(value);
    return mongoose.isValidObjectId(id) ? { id, name: null } : null;
};

/**
 * PublicRun (JOB-FEED.md §5.1) from an in-memory run or a JobSyncRun document
 * (with or without `triggeredBy` populated).
 */
export const toPublicRun = (run) => {
    if (!run) return null;
    const by = run.triggeredByInfo ?? triggeredByOf(run.triggeredBy);
    return {
        id: String(run._id ?? run.id),
        trigger: run.trigger,
        triggeredBy: by ? { id: by.id, name: by.name ?? null } : null,
        status: run.status,
        startedAt: toDate(run.startedAt),
        finishedAt: toDate(run.finishedAt),
        durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
        results: (run.results || []).map((result) => ({
            source: result.source,
            label: sourceLabel(result.source),
            received: result.received ?? 0,
            inserted: result.inserted ?? 0,
            duplicates: result.duplicates ?? 0,
            skipped: result.skipped ?? 0,
            error: result.error ?? null,
            durationMs: result.durationMs ?? 0,
        })),
        totals: { ...emptyTotals(), ...(run.totals && typeof run.totals === "object" ? pickTotals(run.totals) : {}) },
        sampleJobsRemoved: run.sampleJobsRemoved ?? 0,
        error: run.error ?? null,
    };
};

function pickTotals(totals) {
    return {
        received: totals.received ?? 0,
        inserted: totals.inserted ?? 0,
        duplicates: totals.duplicates ?? 0,
        skipped: totals.skipped ?? 0,
    };
}

/** ok = no source error; partial = some failed, some worked; failed = every source failed. */
export const runStatus = (results) => {
    if (!results.length) return "ok";
    const failed = results.filter((result) => result.error).length;
    if (failed === 0) return "ok";
    return failed === results.length ? "failed" : "partial";
};

const formatSeconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

export const formatRunLog = (run) => {
    const parts = run.results.map((result) => (result.error
        ? `${sourceLabel(result.source)}: failed (${result.error})`
        : `${sourceLabel(result.source)}: ${result.inserted} new, ${result.duplicates} known, ${result.skipped} skipped`));
    if (run.error) parts.push(`error: ${run.error}`);
    return `[job-feed] sync ${run.trigger} ${run.status} in ${formatSeconds(run.durationMs ?? 0)}${parts.length ? ` — ${parts.join("; ")}` : ""}`;
};

// ── Helpers (exported, unit-tested) ─────────────────────────────────────────

/**
 * Whether the boot sync should run: true when there is no ok|partial run, or the last one
 * started more than the interval (60 min when the interval is 0) ago. `lastRun` (optional,
 * any finished status) additionally holds back a restart that follows a failed attempt
 * by less than FAILED_BOOT_RETRY_MINUTES, so dev restarts never hammer a feed that is down.
 */
export const shouldRunBootSync = ({ lastSuccessfulRun = null, lastRun = null, now = new Date(), intervalMinutes = 60 } = {}) => {
    const windowMinutes = intervalMinutes > 0 ? intervalMinutes : BOOT_SYNC_FALLBACK_MINUTES;
    const lastSuccessAt = lastSuccessfulRun?.startedAt ? new Date(lastSuccessfulRun.startedAt) : null;
    if (lastSuccessAt && lastSuccessAt.getTime() >= now.getTime() - windowMinutes * MINUTE_MS) return false;
    if (lastRun?.status === "failed" && lastRun.startedAt) {
        const retryMinutes = Math.min(windowMinutes, FAILED_BOOT_RETRY_MINUTES);
        if (new Date(lastRun.startedAt).getTime() >= now.getTime() - retryMinutes * MINUTE_MS) return false;
    }
    return true;
};

/** Runs left "running" by a previous process are failed (single-process deployment). Returns the count. */
export const markInterruptedRuns = async (now = new Date()) => {
    const result = await JobSyncRun.updateMany(
        { status: "running" },
        { $set: { status: "failed", finishedAt: now, error: INTERRUPTED_RUN_ERROR } },
    );
    return result.modifiedCount ?? 0;
};

/** Deletes non-sample, unsaved jobs not seen for `retentionDays`. Returns {deleted}. */
export const purgeStaleJobs = async ({ retentionDays, now = new Date(), logger = defaultLogger } = {}) => {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0 };
    const saved = await SavedJob.distinct("job");
    const result = await ExternalJob.deleteMany({
        isSample: false,
        lastSeenAt: { $lt: new Date(now.getTime() - days * DAY_MS) },
        _id: { $nin: saved },
    });
    const deleted = result.deletedCount ?? 0;
    if (deleted > 0) logger.log(`[job-feed] purged ${deleted} job(s) not seen for ${days} day(s).`);
    return { deleted };
};

/** Once real jobs exist, demo listings nobody saved are removed. Returns the number deleted. */
export const removeUnsavedSampleJobs = async () => {
    if (!(await ExternalJob.exists({ isSample: false }))) return 0;
    const saved = await SavedJob.distinct("job");
    const result = await ExternalJob.deleteMany({ isSample: true, _id: { $nin: saved } });
    return result.deletedCount ?? 0;
};

/** Newest ok|partial run (lean) or null. */
export const findLastSuccessfulRun = () =>
    JobSyncRun.findOne({ status: { $in: ["ok", "partial"] } }).sort({ startedAt: -1 }).lean();

/** Newest finished run (lean) or null. */
export const findLastFinishedRun = (excludeId = null) =>
    JobSyncRun.findOne({ status: { $ne: "running" }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
        .sort({ startedAt: -1 })
        .lean();

// ── Default post-run hooks ──────────────────────────────────────────────────

/** Socket events + notifications after a run; each hook is best-effort. */
export const defaultAfterRun = async (run, { insertedIds = [], previousRun = null, logger = defaultLogger } = {}) => {
    const hooks = [
        () => emitToRoles(["tpo", "admin"], "job-feed:sync", { run }),
        () => {
            if ((run.totals?.inserted ?? 0) > 0) {
                emitToRoles(["student", "tpo", "admin"], "job-feed:updated", {
                    inserted: run.totals.inserted,
                    source: "sync",
                    at: run.finishedAt ?? new Date(),
                });
            }
        },
        () => notifyMatchDigest({ run, insertedIds, now: run.finishedAt ?? new Date() }),
        () => notifySyncFailure({ run, previousRun, now: run.finishedAt ?? new Date() }),
    ];
    for (const hook of hooks) {
        try {
            await hook();
        } catch (error) {
            logger.error("[job-feed] a post-sync step failed:", error?.message || error);
        }
    }
};

// ── Service ─────────────────────────────────────────────────────────────────

export class JobSyncService {
    constructor({
        repository = new JobRepository(),
        sources = null,
        persist = true,
        afterRun = defaultAfterRun,
        logger = defaultLogger,
    } = {}) {
        this.repository = repository;
        // null → getPolledSources() at each run; tests assign fake sources here.
        this.sources = sources;
        this.persist = persist;
        this.afterRun = afterRun;
        this.logger = logger;
        this.running = null;
        this.lastFinishedRun = null;
    }

    // Saves jobs from any source. Polled sources arrive through sync(); a push source, such as the WhatsApp
    // listener, or the sample seed calls this directly.
    async ingest(source, inputs, seenAt = new Date()) {
        const list = Array.isArray(inputs) ? inputs : [];
        const uniqueJobs = new Map();
        let skipped = 0;
        for (const input of list) {
            const job = normalizeJob(input, { source, seenAt });
            if (!job) {
                skipped += 1;
                continue;
            }
            const sameJob = uniqueJobs.get(job.dedupeKey);
            if (!sameJob) {
                uniqueJobs.set(job.dedupeKey, job);
                continue;
            }
            if (job.postedAt > sameJob.postedAt) sameJob.postedAt = job.postedAt;
            sameJob.sources.push(...job.sources);
            sameJob.categories = [...new Set([...sameJob.categories, ...job.categories])];
            // Fill fields the first copy lacked (the stored job's own values always win, see the repository).
            for (const [field, value] of Object.entries(job)) {
                if (sameJob[field] == null && value != null) sameJob[field] = value;
            }
        }

        const { inserted, insertedIds } = await this.repository.upsertMany([...uniqueJobs.values()], seenAt, { source });
        return {
            received: list.length,
            inserted,
            duplicates: list.length - skipped - inserted,
            skipped,
            insertedIds: insertedIds ?? [],
        };
    }

    async syncSource(source, { onBatch = null } = {}) {
        const startedAt = Date.now();
        const result = {
            source: source?.name || "unknown",
            received: 0,
            inserted: 0,
            duplicates: 0,
            skipped: 0,
            error: null,
            durationMs: 0,
            insertedIds: [],
        };
        try {
            if (typeof source?.fetchBatches !== "function") throw new Error("The source has no fetchBatches().");
            for await (const batch of source.fetchBatches()) {
                const stats = await this.ingest(result.source, batch);
                result.received += stats.received;
                result.inserted += stats.inserted;
                result.duplicates += stats.duplicates;
                result.skipped += stats.skipped;
                result.insertedIds.push(...stats.insertedIds);
                onBatch?.(result);
            }
        } catch (error) {
            result.error = error?.message || "The source could not be synced.";
        }
        result.durationMs = Date.now() - startedAt;
        return result;
    }

    isRunning() {
        return Boolean(this.running);
    }

    /** The run in progress as a PublicRun (status "running"), or null. */
    current() {
        return this.running ? toPublicRun(this.running.run) : null;
    }

    // Only one sync runs at a time. Anyone who asks while it is running shares its promise (and result object).
    sync({ trigger = "manual", triggeredBy = null } = {}) {
        if (this.running) return this.running.promise;
        const by = triggeredByOf(triggeredBy);
        const run = {
            _id: new mongoose.Types.ObjectId(),
            trigger,
            triggeredBy: by?.id ?? null,
            triggeredByInfo: by,
            status: "running",
            startedAt: new Date(),
            finishedAt: null,
            durationMs: null,
            results: [],
            totals: emptyTotals(),
            sampleJobsRemoved: 0,
            error: null,
        };
        const entry = { run, promise: null };
        this.running = entry;
        entry.promise = this.execute(run).finally(() => {
            if (this.running === entry) this.running = null;
        });
        return entry.promise;
    }

    async execute(run) {
        const insertedIds = [];
        let previousRun = null;
        try {
            await this.resolveTriggeredByName(run);
            previousRun = await this.findPreviousRun(run);
            await this.persistStart(run);
            emitToRoles(["tpo", "admin"], "job-feed:sync", { run: toPublicRun(run) });

            const sources = this.sources ?? getPolledSources(getJobFeedConfig());
            for (const source of sources) {
                const result = await this.syncSource(source);
                const { insertedIds: ids, ...publicResult } = result;
                insertedIds.push(...ids);
                run.results.push(publicResult);
                for (const key of Object.keys(run.totals)) run.totals[key] += publicResult[key];
                if (publicResult.error) this.logger.warn(`[job-feed] ${sourceLabel(publicResult.source)} sync failed: ${publicResult.error}`);
            }
            run.status = runStatus(run.results);
            if (run.status !== "failed") {
                try {
                    run.sampleJobsRemoved = await removeUnsavedSampleJobs();
                } catch (error) {
                    this.logger.error("[job-feed] sample cleanup failed:", error?.message || error);
                }
            }
        } catch (error) {
            run.status = "failed";
            run.error = error?.message || "The sync could not be completed.";
        }

        run.finishedAt = new Date();
        run.durationMs = run.finishedAt.getTime() - run.startedAt.getTime();
        await this.persistFinish(run);
        this.lastFinishedRun = { _id: run._id, status: run.status, startedAt: run.startedAt };
        this.logger.log(formatRunLog(run));

        const publicRun = toPublicRun(run);
        try {
            await this.afterRun?.(publicRun, { insertedIds, previousRun, logger: this.logger });
        } catch (error) {
            this.logger.error("[job-feed] post-sync hooks failed:", error?.message || error);
        }
        return publicRun;
    }

    async resolveTriggeredByName(run) {
        if (!run.triggeredByInfo || run.triggeredByInfo.name) return;
        try {
            const User = mongoose.models.User;
            const user = User ? await User.findById(run.triggeredByInfo.id).select("name").lean() : null;
            run.triggeredByInfo = { id: run.triggeredByInfo.id, name: user?.name ?? null };
        } catch {
            // The name is cosmetic; the id is what is stored.
        }
    }

    async findPreviousRun(run) {
        if (!this.persist) return this.lastFinishedRun;
        try {
            return (await findLastFinishedRun(run._id)) ?? null;
        } catch (error) {
            this.logger.error("[job-feed] could not read the previous sync run:", error?.message || error);
            return this.lastFinishedRun;
        }
    }

    async persistStart(run) {
        if (!this.persist) return;
        try {
            await JobSyncRun.create({
                _id: run._id,
                trigger: run.trigger,
                triggeredBy: run.triggeredBy,
                status: "running",
                startedAt: run.startedAt,
                results: [],
                totals: emptyTotals(),
            });
        } catch (error) {
            this.logger.error("[job-feed] could not save the sync run:", error?.message || error);
        }
    }

    async persistFinish(run) {
        if (!this.persist) return;
        try {
            await JobSyncRun.updateOne(
                { _id: run._id },
                {
                    $set: {
                        trigger: run.trigger,
                        triggeredBy: run.triggeredBy,
                        status: run.status,
                        startedAt: run.startedAt,
                        finishedAt: run.finishedAt,
                        durationMs: run.durationMs,
                        results: run.results,
                        totals: run.totals,
                        sampleJobsRemoved: run.sampleJobsRemoved,
                        ...(run.error ? { error: run.error } : {}),
                    },
                },
                { upsert: true },
            );
        } catch (error) {
            this.logger.error("[job-feed] could not save the sync run:", error?.message || error);
        }
    }
}

export const jobSyncService = new JobSyncService();

// ── Schedule info (GET /sync/status) ────────────────────────────────────────

let scheduleRegisteredAt = null;

/** Called by index.js when the periodic sync job is registered. */
export const markScheduleRegistered = (at = new Date()) => {
    scheduleRegisteredAt = at;
};

export const getScheduleRegisteredAt = () => scheduleRegisteredAt;
