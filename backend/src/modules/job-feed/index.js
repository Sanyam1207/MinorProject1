// Module "job-feed": the open-market job feed ported from Matchy
// (docs/contracts/JOB-FEED.md). ExternalJob aggregation from external sources,
// search, the student job tracker, scheduled sync and copilot tools.
//
// start() is called once after MongoDB connects. It never throws and never
// touches the network itself: the boot sync runs only when the last successful
// sync is older than the interval, so dev restarts (--watch) do not hammer the
// third-party feeds. WhatsApp stays off unless WHATSAPP_ENABLED=true, and the
// optional "baileys" package is only ever loaded lazily by the listener.
import { isSchedulerEnabled, registerJob } from "../../core/scheduler.js";
import { getJobFeedConfig } from "./config.js";
import router from "./routes.js";
import {
    defaultLogger,
    findLastFinishedRun,
    findLastSuccessfulRun,
    jobSyncService,
    markInterruptedRuns,
    markScheduleRegistered,
    purgeStaleJobs,
    shouldRunBootSync,
} from "./sync.service.js";
import tools from "./tools.js";

// For the demo seed (AUTH-FACULTY.md §16): seedSampleJobs is an alias of seedSampleExternalJobs.
export { removeSampleJobs, seedSampleExternalJobs, seedSampleJobs } from "./sample-jobs.js";

const BOOT_SYNC_DELAY_MS = 5_000;
const PURGE_INTERVAL_MS = 24 * 60 * 60_000;

/** Run the boot sync only when the last successful one is stale. Resolves to the run, or null when skipped. */
export const runBootSyncIfStale = async (config = getJobFeedConfig(), { now = new Date(), logger = defaultLogger } = {}) => {
    const [lastSuccessfulRun, lastRun] = await Promise.all([findLastSuccessfulRun(), findLastFinishedRun()]);
    if (!shouldRunBootSync({ lastSuccessfulRun, lastRun, now, intervalMinutes: config.syncIntervalMinutes })) {
        const minutes = lastSuccessfulRun
            ? Math.round((now.getTime() - new Date(lastSuccessfulRun.startedAt).getTime()) / 60_000)
            : null;
        logger.log(minutes === null
            ? "[job-feed] boot sync skipped: the last attempt failed moments ago; the schedule will retry."
            : `[job-feed] boot sync skipped: the last successful sync was ${minutes} min ago.`);
        return null;
    }
    return jobSyncService.sync({ trigger: "boot" });
};

export const start = async () => {
    try {
        const config = getJobFeedConfig();
        const interrupted = await markInterruptedRuns(new Date());
        if (interrupted > 0) defaultLogger.warn(`[job-feed] marked ${interrupted} interrupted sync run(s) as failed.`);

        if (config.syncIntervalMinutes > 0) {
            registerJob("job-feed:sync", config.syncIntervalMinutes * 60_000, () => jobSyncService.sync({ trigger: "schedule" }));
            markScheduleRegistered(new Date());
        }
        if (config.retentionDays > 0) {
            registerJob("job-feed:purge", PURGE_INTERVAL_MS, () => purgeStaleJobs({ retentionDays: config.retentionDays, now: new Date() }));
        }
        if (isSchedulerEnabled() && config.syncOnBoot) {
            setTimeout(() => {
                runBootSyncIfStale(config).catch((error) => console.error("[job-feed] boot sync failed:", error?.message || error));
            }, BOOT_SYNC_DELAY_MS).unref();
        }
        if (config.whatsappEnabled && process.env.NODE_ENV !== "test") {
            import("./whatsapp/listener.service.js")
                .then(({ startWhatsAppListener }) => startWhatsAppListener({
                    onFatal: (message) => console.error(`[job-feed] WhatsApp: ${message} The API keeps running.`),
                }))
                .catch((error) => console.error("[job-feed] WhatsApp listener failed to start:", error?.message || error));
        }
    } catch (error) {
        console.error("[job-feed] start failed; the feed keeps serving stored jobs:", error?.message || error);
    }
};

export default {
    name: "job-feed",
    mountPath: "/api/v1/job-feed",
    router,
    start,
    tools,
};
