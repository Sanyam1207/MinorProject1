// Tiny in-process job runner for periodic background work (attendance
// reminders, QR rotation, timetable materialisation, job-feed sync, ...).
//
// - Jobs never overlap with themselves (a slow tick is skipped, not stacked).
// - A failing job is logged and retried on its next tick.
// - Disabled when NODE_ENV=test or DISABLE_SCHEDULER=true so tests stay
//   deterministic; tests call runJobNow(name) instead.

const jobs = new Map();
let started = false;

const startJob = (job) => {
    if (job.timer) return;
    const tick = async () => {
        if (job.running) return;
        job.running = true;
        job.lastRunAt = new Date();
        try {
            await job.fn();
            job.lastError = null;
        } catch (error) {
            job.lastError = error?.message || String(error);
            console.error(`[scheduler] job "${job.name}" failed:`, error);
        } finally {
            job.running = false;
        }
    };
    job.timer = setInterval(tick, job.intervalMs);
    job.timer.unref?.();
    if (job.runOnStart) setImmediate(tick);
};

/**
 * Register a periodic job. Safe to call before or after startScheduler().
 * @param {string} name unique job name
 * @param {number} intervalMs tick interval in milliseconds (>= 250)
 * @param {() => Promise<void>|void} fn work to run
 * @param {{runOnStart?: boolean}} [options]
 */
export const registerJob = (name, intervalMs, fn, { runOnStart = false } = {}) => {
    if (!name || typeof fn !== "function") throw new Error("registerJob requires a name and a function");
    const existing = jobs.get(name);
    if (existing?.timer) clearInterval(existing.timer);
    const job = {
        name,
        intervalMs: Math.max(250, Number(intervalMs) || 60_000),
        fn,
        runOnStart,
        timer: null,
        running: false,
        lastRunAt: null,
        lastError: null,
    };
    jobs.set(name, job);
    if (started) startJob(job);
    return job;
};

export const isSchedulerEnabled = () =>
    process.env.NODE_ENV !== "test" && process.env.DISABLE_SCHEDULER !== "true";

export const startScheduler = () => {
    if (started || !isSchedulerEnabled()) return false;
    started = true;
    for (const job of jobs.values()) startJob(job);
    return true;
};

export const stopScheduler = () => {
    for (const job of jobs.values()) {
        if (job.timer) clearInterval(job.timer);
        job.timer = null;
    }
    started = false;
};

/** Run a registered job immediately (used by tests and admin endpoints). */
export const runJobNow = async (name) => {
    const job = jobs.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    await job.fn();
};

export const listJobs = () => [...jobs.values()].map(({ name, intervalMs, lastRunAt, lastError, running }) => ({
    name,
    intervalMs,
    lastRunAt,
    lastError,
    running,
}));
