// Job-feed notifications, sent only through notifications/notify.js
// (docs/contracts/JOB-FEED.md §9):
//   jobfeed.matches      — daily "new jobs match your profile" digest for students
//   jobfeed.sync.failed  — the feed is down (TPO / admin)
import { DateTime } from "luxon";
import { notify, notifyRole } from "../notifications/notify.js";
import { User } from "../../models/user.models.js";
import { getJobFeedConfig } from "./config.js";
import { sourceLabel } from "./constants.js";
import { buildProfileSignals, scoreExternalJob } from "./match.js";
import { ExternalJob } from "./models/external-job.model.js";

export const MATCH_DIGEST_CANDIDATES = 200;
export const MATCH_DIGEST_MIN_SCORE = 60;
export const MATCH_DIGEST_BATCH = 200;
const HIGHLIGHT_IDS_MAX = 10;
const BODY_MAX = 1000;

const appTimezone = () => (process.env.APP_TIMEZONE || "Asia/Kolkata").trim();

/** YYYY-MM-DD of `now` in APP_TIMEZONE. */
export const dayKey = (now = new Date()) => {
    const zoned = DateTime.fromJSDate(now).setZone(appTimezone());
    return (zoned.isValid ? zoned : DateTime.fromJSDate(now).setZone("UTC")).toISODate();
};

const clip = (text, max = BODY_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const shortLabel = (job) => {
    const title = job.title || "A new role";
    return job.company ? `${title} at ${job.company}` : title;
};

/** "<Title> at <Company>, <Title> at <Company> and N more." (only as many labels as exist). */
export const digestBody = (jobs) => {
    const labels = jobs.slice(0, 2).map(shortLabel);
    if (jobs.length > 2) return clip(`${labels.join(", ")} and ${jobs.length - 2} more.`);
    return clip(`${labels.join(" and ")}.`);
};

const digestRecipients = () => User.find({
    role: "student",
    isActive: { $ne: false },
    $or: [
        { "skills.0": { $exists: true } },
        { "projects.skills.0": { $exists: true } },
        { "careerPreferences.preferredRoles.0": { $exists: true } },
    ],
}).select("_id skills projects careerPreferences").lean().cursor({ batchSize: MATCH_DIGEST_BATCH });

/**
 * After a sync that inserted real jobs: each student whose profile fits ≥1 new job
 * (score ≥ 60) gets one `jobfeed.matches` per day. Returns {created, recipients}.
 */
export const notifyMatchDigest = async ({ run, insertedIds = [], now = new Date(), config = getJobFeedConfig() } = {}) => {
    if (!config.matchDigest || !insertedIds.length) return { created: 0, recipients: 0 };
    const jobs = await ExternalJob.find({ _id: { $in: insertedIds }, isSample: false })
        .sort({ postedAt: -1, _id: -1 })
        .limit(MATCH_DIGEST_CANDIDATES)
        .select("title company location categories description workType postedAt")
        .lean();
    if (!jobs.length) return { created: 0, recipients: 0 };

    const dedupeKey = `jobfeed-matches:${dayKey(now)}`;
    let created = 0;
    let recipients = 0;
    let inBatch = 0;
    for await (const student of digestRecipients()) {
        const signals = buildProfileSignals(student);
        if (signals) {
            const matches = jobs
                .map((job, index) => ({ job, index, score: scoreExternalJob(job, signals, now).score ?? 0 }))
                .filter(({ score }) => score >= MATCH_DIGEST_MIN_SCORE)
                .sort((a, b) => b.score - a.score || a.index - b.index)
                .map(({ job }) => job);
            if (matches.length) {
                const n = matches.length;
                const jobIds = matches.slice(0, HIGHLIGHT_IDS_MAX).map((job) => String(job._id));
                const result = await notify(student._id, {
                    type: "jobfeed.matches",
                    title: n === 1 ? "1 new job matches your profile" : `${n} new jobs match your profile`,
                    body: digestBody(matches),
                    ui: { panel: "jobs.market", params: { sort: "match", highlightIds: jobIds } },
                    data: { jobIds, runId: run?.id ?? null },
                    priority: "low",
                    push: false,
                    email: false,
                    dedupeKey,
                });
                created += result.created;
                recipients += 1;
            }
        }
        inBatch += 1;
        if (inBatch >= MATCH_DIGEST_BATCH) {
            inBatch = 0;
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    return { created, recipients };
};

const withoutTrailingPeriod = (text) => String(text ?? "").trim().replace(/[.\s]+$/, "");

/** Body of `jobfeed.sync.failed`. */
export const syncFailureBody = (run, config = getJobFeedConfig()) => {
    const failures = (run.results || [])
        .filter((result) => result.error)
        .map((result) => `${result.label || sourceLabel(result.source)}: ${withoutTrailingPeriod(result.error)}`);
    if (!failures.length && run.error) failures.push(withoutTrailingPeriod(run.error));
    const next = config.syncIntervalMinutes > 0
        ? `the next automatic attempt is in ${config.syncIntervalMinutes} min.`
        : "automatic syncing is off (JOB_SYNC_INTERVAL_MINUTES=0).";
    return clip(`No source could be reached (${failures.join("; ") || "unknown error"}). Existing jobs are kept; ${next}`);
};

/**
 * When a run fails after a run that did not (or after none), every active TPO and
 * admin gets one `jobfeed.sync.failed` per day. Returns {created, recipients}.
 */
export const notifySyncFailure = async ({ run, previousRun = null, now = new Date(), config = getJobFeedConfig() } = {}) => {
    if (run?.status !== "failed") return { created: 0, recipients: 0 };
    if (previousRun && previousRun.status === "failed") return { created: 0, recipients: 0 };
    return notifyRole(["tpo", "admin"], {
        type: "jobfeed.sync.failed",
        title: "Job feed sync failed",
        body: syncFailureBody(run, config),
        ui: { panel: "tpo.job-feed", params: { runId: run.id } },
        data: { runId: run.id },
        priority: "normal",
        push: false,
        dedupeKey: `jobfeed-sync-failed:${dayKey(now)}`,
    });
};
