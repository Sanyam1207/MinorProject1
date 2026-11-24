// The student's job tracker for open-market jobs (docs/contracts/JOB-FEED.md §2.2, §7.7).
// Tracker actions never notify.
import mongoose from "mongoose";
import { fail, intParam, isObjectId } from "../../core/http.js";
import { APPLIED_STATUSES, SAVED_JOB_STATUSES } from "./constants.js";
import { toPublicJob } from "./feed.service.js";
import { ExternalJob } from "./models/external-job.model.js";
import { SAVED_JOB_HISTORY_MAX, SAVED_JOB_NOTES_MAX, SavedJob } from "./models/saved-job.model.js";

const userIdOf = (user) => {
    const id = user?._id ?? user;
    if (!id || !mongoose.isValidObjectId(String(id))) throw fail(401, "Sign in to use the job tracker", "UNAUTHORIZED");
    return new mongoose.Types.ObjectId(String(id));
};

const assertJobId = (jobId) => {
    const value = String(jobId?._id ?? jobId ?? "").trim();
    if (!isObjectId(value)) throw fail(400, "jobId must be a valid job id", "VALIDATION", { field: "jobId" });
    return new mongoose.Types.ObjectId(value);
};

const validateStatus = (status) => {
    if (status === undefined || status === null) return undefined;
    const value = typeof status === "string" ? status.trim().toLowerCase() : "";
    if (!SAVED_JOB_STATUSES.includes(value)) {
        throw fail(400, `Unknown status. Use one of: ${SAVED_JOB_STATUSES.join(", ")}.`, "VALIDATION", { field: "status" });
    }
    return value;
};

const validateNotes = (notes) => {
    if (notes === undefined || notes === null) return undefined;
    if (typeof notes !== "string" || notes.length > SAVED_JOB_NOTES_MAX) {
        throw fail(400, `notes must be text of at most ${SAVED_JOB_NOTES_MAX} characters.`, "VALIDATION", { field: "notes" });
    }
    return notes.trim();
};

const snapshotOf = (job) => ({
    title: job.title ?? null,
    company: job.company ?? null,
    location: job.location ?? null,
    applyUrl: job.applyUrl ?? null,
    jobType: job.jobType ?? null,
    workType: job.workType ?? null,
    salary: job.salary ?? null,
    postedAt: job.postedAt ?? null,
    sources: [...new Set((job.sources || []).map((source) => source?.name).filter(Boolean))],
});

/**
 * SavedJobView (JOB-FEED.md §7.7). `job` is the live ExternalJob (or null when it was purged).
 */
export const toSavedJobView = (entry, job = null, { now = new Date() } = {}) => {
    let publicJob = null;
    if (job) {
        const { saved: _saved, ...rest } = toPublicJob(job, { now });
        publicJob = rest;
    }
    const snapshot = entry.snapshot || {};
    return {
        id: String(entry._id),
        jobId: String(entry.job),
        status: entry.status,
        notes: entry.notes ?? "",
        savedAt: entry.createdAt ?? null,
        appliedAt: entry.appliedAt ?? null,
        statusChangedAt: entry.statusChangedAt ?? null,
        updatedAt: entry.updatedAt ?? null,
        history: (entry.history || []).map((item) => ({ status: item.status, at: item.at ?? null })),
        job: publicJob,
        snapshot: {
            title: snapshot.title ?? null,
            company: snapshot.company ?? null,
            location: snapshot.location ?? null,
            applyUrl: snapshot.applyUrl ?? null,
            jobType: snapshot.jobType ?? null,
            workType: snapshot.workType ?? null,
            salary: snapshot.salary ?? null,
            postedAt: snapshot.postedAt ?? null,
            sources: Array.isArray(snapshot.sources) ? [...snapshot.sources] : [],
        },
        jobAvailable: Boolean(job),
    };
};

const viewWithJob = async (entry, now) => {
    const job = await ExternalJob.findById(entry.job).lean();
    return toSavedJobView(entry, job, { now });
};

/** Counts per status for one user: {saved, applied, interviewing, offer, rejected, total}. */
export const countSavedJobs = async (userId) => {
    const rows = await SavedJob.aggregate([
        { $match: { user: userId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(SAVED_JOB_STATUSES.map((status) => [status, 0]));
    for (const row of rows) if (row._id in counts) counts[row._id] = row.count;
    counts.total = SAVED_JOB_STATUSES.reduce((sum, status) => sum + counts[status], 0);
    return counts;
};

/** GET /saved — newest activity first. */
export const listSavedJobs = async ({ user, status, page, limit, now = new Date() } = {}) => {
    const userId = userIdOf(user);
    const statusFilter = status === undefined || status === null || status === "" ? undefined : validateStatus(status);
    const pageNumber = intParam(page, { min: 1, max: 1000, fallback: 1 });
    const pageSize = intParam(limit, { min: 1, max: 100, fallback: 50 });
    const filter = { user: userId, ...(statusFilter ? { status: statusFilter } : {}) };

    const [entries, total, counts] = await Promise.all([
        SavedJob.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean(),
        SavedJob.countDocuments(filter),
        countSavedJobs(userId),
    ]);
    const jobs = await ExternalJob.find({ _id: { $in: entries.map((entry) => entry.job) } }).lean();
    const jobsById = new Map(jobs.map((job) => [String(job._id), job]));
    return {
        items: entries.map((entry) => toSavedJobView(entry, jobsById.get(String(entry.job)) ?? null, { now })),
        counts,
        page: pageNumber,
        limit: pageSize,
        total,
        hasNextPage: pageNumber * pageSize < total,
    };
};

/** The user's tracker entry for a job (lean) or null. */
export const findSavedJob = async ({ user, jobId }) =>
    SavedJob.findOne({ user: userIdOf(user), job: assertJobId(jobId) }).lean();

const updateExisting = async (existing, { status, notes, now }) => {
    const set = {};
    const update = {};
    if (notes !== undefined && notes !== existing.notes) set.notes = notes;
    if (status !== undefined && status !== existing.status) {
        set.status = status;
        set.statusChangedAt = now;
        if (status === "saved") set.appliedAt = null;
        else if (APPLIED_STATUSES.includes(status) && !existing.appliedAt) set.appliedAt = now;
        update.$push = { history: { $each: [{ status, at: now }], $slice: -SAVED_JOB_HISTORY_MAX } };
    }
    if (!Object.keys(set).length) return existing;
    update.$set = set;
    return SavedJob.findOneAndUpdate({ _id: existing._id }, update, { returnDocument: "after", lean: true });
};

/**
 * Idempotent upsert keyed by (user, jobId). An existing entry is updated even if its
 * job was purged; a new entry needs the ExternalJob (else 404) and copies its snapshot.
 * @returns {Promise<{item: object, created: boolean, previousStatus: string|null}>}
 */
export const upsertSavedJob = async ({ user, jobId, status, notes, now = new Date() } = {}) => {
    const userId = userIdOf(user);
    const job = assertJobId(jobId);
    const nextStatus = validateStatus(status);
    const nextNotes = validateNotes(notes);

    const existing = await SavedJob.findOne({ user: userId, job }).lean();
    if (existing) {
        const updated = await updateExisting(existing, { status: nextStatus, notes: nextNotes, now });
        return { item: await viewWithJob(updated, now), created: false, previousStatus: existing.status };
    }

    const doc = await ExternalJob.findById(job).lean();
    if (!doc) throw fail(404, "This job is no longer in the feed.", "NOT_FOUND");
    const initialStatus = nextStatus ?? "saved";
    try {
        const created = await SavedJob.create({
            user: userId,
            job,
            status: initialStatus,
            notes: nextNotes ?? "",
            appliedAt: APPLIED_STATUSES.includes(initialStatus) ? now : null,
            statusChangedAt: now,
            history: [{ status: initialStatus, at: now }],
            snapshot: snapshotOf(doc),
        });
        return { item: toSavedJobView(created.toObject(), doc, { now }), created: true, previousStatus: null };
    } catch (error) {
        if (error?.code !== 11000) throw error;
        // A concurrent request created the entry first: apply this one as an update.
        const raced = await SavedJob.findOne({ user: userId, job }).lean();
        const updated = await updateExisting(raced, { status: nextStatus, notes: nextNotes, now });
        return { item: await viewWithJob(updated, now), created: false, previousStatus: raced.status };
    }
};

/** DELETE /saved/:jobId → {deleted: true}; 404 when the job is not in the tracker. */
export const removeSavedJob = async ({ user, jobId }) => {
    const result = await SavedJob.deleteOne({ user: userIdOf(user), job: assertJobId(jobId) });
    if (!result.deletedCount) throw fail(404, "This job is not in your tracker.", "NOT_FOUND");
    return { deleted: true };
};
