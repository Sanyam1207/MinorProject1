// REST API of the open-market job feed, mounted at /api/v1/job-feed
// (docs/contracts/JOB-FEED.md §7). Registration order keeps /:id from shadowing
// a named path. Responses use the SIH envelope through core/http.js.
import crypto from "node:crypto";
import express from "express";
import { asyncHandler, fail, requireAuth, requireRole, send } from "../../core/http.js";
import { rateLimit } from "../../core/rate-limit.js";
import { isSchedulerEnabled, listJobs } from "../../core/scheduler.js";
import { getJobFeedConfig } from "./config.js";
import {
    getExternalJobForViewer,
    listCategories,
    listSourceInfo,
    searchMarketJobs,
} from "./feed.service.js";
import { ExternalJob } from "./models/external-job.model.js";
import { JobSyncRun } from "./models/job-sync-run.model.js";
import { SavedJob } from "./models/saved-job.model.js";
import { getScheduleRegisteredAt, jobSyncService, toPublicRun } from "./sync.service.js";
import { listSavedJobs, removeSavedJob, upsertSavedJob } from "./tracker.service.js";
import { getWhatsAppStatus } from "./whatsapp/status.js";

export const SYNC_SECRET_HEADER = "x-admin-sync-secret";
const RECENT_RUNS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const router = express.Router();

const safeEqual = (expected, supplied) => {
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(supplied));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * POST /sync auth: header `x-admin-sync-secret` (cron) must equal ADMIN_SYNC_SECRET;
 * without the header a tpo/admin access token is required (manual).
 */
export const syncAuth = (req, res, next) => {
    const supplied = req.get(SYNC_SECRET_HEADER);
    if (supplied !== undefined) {
        const configured = getJobFeedConfig().adminSyncSecret;
        if (!configured || !safeEqual(configured, supplied)) {
            return next(fail(401, "Invalid sync secret", "INVALID_SYNC_SECRET"));
        }
        req.jobFeedSyncTrigger = "cron";
        return next();
    }
    return requireAuth(req, res, (authError) => {
        if (authError) return next(authError);
        return requireRole("tpo")(req, res, (roleError) => {
            if (roleError) return next(roleError);
            req.jobFeedSyncTrigger = "manual";
            return next();
        });
    });
};

const syncRateLimit = rateLimit({
    windowMs: 60_000,
    max: 3,
    keyFn: (req) => String(req.user?._id || "cron"),
    message: "Too many sync requests. Please wait a minute and try again.",
});

const isTruthy = (value) => ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());

router.post("/sync", syncAuth, syncRateLimit, asyncHandler(async (req, res) => {
    const trigger = req.jobFeedSyncTrigger || "manual";
    const alreadyRunning = jobSyncService.isRunning();
    const promise = jobSyncService.sync({ trigger, triggeredBy: trigger === "cron" ? null : req.user });
    if (isTruthy(req.query.wait)) {
        const run = await promise;
        return send(res, { run }, "Job feed sync finished", 200);
    }
    promise.catch((error) => console.error("[job-feed] background sync failed:", error?.message || error));
    return send(res, { run: jobSyncService.current(), alreadyRunning }, alreadyRunning ? "A sync is already running" : "Job feed sync started", 202);
}));

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
    // `query` (UI-ACTIONS' panel param name) is accepted as an alias of `q`.
    const query = req.query || {};
    const data = await searchMarketJobs({
        q: query.q ?? query.query,
        category: query.category,
        jobType: query.jobType,
        workType: query.workType,
        location: query.location,
        source: query.source,
        sort: query.sort,
        page: query.page,
        limit: query.limit,
        viewer: req.user,
        now: new Date(),
    });
    return send(res, data, "Jobs fetched");
}));

router.get("/categories", asyncHandler(async (_req, res) => send(res, await listCategories(), "Categories fetched")));

router.get("/sources", asyncHandler(async (_req, res) => send(res, { sources: await listSourceInfo() }, "Sources fetched")));

const scheduleInfo = (config, now) => {
    const enabled = config.syncIntervalMinutes > 0 && isSchedulerEnabled();
    let nextRunAt = null;
    if (enabled) {
        const job = listJobs().find((entry) => entry.name === "job-feed:sync");
        const base = job?.lastRunAt ?? (job ? getScheduleRegisteredAt() : null);
        if (base) {
            const next = new Date(new Date(base).getTime() + config.syncIntervalMinutes * 60_000);
            nextRunAt = next < now ? now : next;
        }
    }
    return { intervalMinutes: config.syncIntervalMinutes, onBoot: config.syncOnBoot, enabled, nextRunAt };
};

router.get("/sync/status", requireRole("tpo"), asyncHandler(async (_req, res) => {
    const config = getJobFeedConfig();
    const now = new Date();
    const populate = { path: "triggeredBy", select: "name" };
    const [recent, lastRun, lastSuccessfulRun, sources, jobs, sampleJobs, savedJobs, newLast24h] = await Promise.all([
        JobSyncRun.find({}).sort({ startedAt: -1 }).limit(RECENT_RUNS).populate(populate).lean(),
        JobSyncRun.findOne({ status: { $ne: "running" } }).sort({ startedAt: -1 }).populate(populate).lean(),
        JobSyncRun.findOne({ status: { $in: ["ok", "partial"] } }).sort({ startedAt: -1 }).populate(populate).lean(),
        listSourceInfo({ config }),
        ExternalJob.countDocuments({}),
        ExternalJob.countDocuments({ isSample: true }),
        SavedJob.countDocuments({}),
        ExternalJob.countDocuments({ postedAt: { $gte: new Date(now.getTime() - DAY_MS) } }),
    ]);
    const current = jobSyncService.current();
    return send(res, {
        running: jobSyncService.isRunning(),
        current,
        lastRun: toPublicRun(lastRun),
        lastSuccessfulRun: toPublicRun(lastSuccessfulRun),
        // The in-process run is the freshest view of a run that is still going.
        recentRuns: recent.map((run) => (current && String(run._id) === current.id ? current : toPublicRun(run))),
        schedule: scheduleInfo(config, now),
        sources,
        whatsapp: getWhatsAppStatus(),
        totals: { jobs, sampleJobs, savedJobs, newLast24h },
    }, "Sync status fetched");
}));

router.get("/saved", requireRole("student"), asyncHandler(async (req, res) => {
    const data = await listSavedJobs({
        user: req.user,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
        now: new Date(),
    });
    return send(res, data, "Saved jobs fetched");
}));

router.put("/saved/:jobId", requireRole("student"), asyncHandler(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { item, created } = await upsertSavedJob({
        user: req.user,
        jobId: req.params.jobId,
        status: body.status,
        notes: body.notes,
        now: new Date(),
    });
    return send(res, { item }, created ? "Job saved" : "Saved job updated", created ? 201 : 200);
}));

router.delete("/saved/:jobId", requireRole("student"), asyncHandler(async (req, res) => {
    const data = await removeSavedJob({ user: req.user, jobId: req.params.jobId });
    return send(res, data, "Saved job removed");
}));

router.get("/:id", asyncHandler(async (req, res) => {
    const job = await getExternalJobForViewer(req.params.id, { viewer: req.user, now: new Date() });
    return send(res, { job }, "Job fetched");
}));

export default router;
