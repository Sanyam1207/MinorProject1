// JobSyncRun — one run of the job-feed sync (docs/contracts/JOB-FEED.md §2.3).
// Kept for 30 days (TTL on startedAt).
import mongoose from "mongoose";
import { SYNC_STATUSES, SYNC_TRIGGERS } from "../constants.js";

export const SYNC_RUN_TTL_SECONDS = 30 * 24 * 60 * 60;

const resultSchema = new mongoose.Schema(
    {
        source: String,
        received: { type: Number, default: 0 },
        inserted: { type: Number, default: 0 },
        duplicates: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
        error: { type: String, default: null },
        durationMs: { type: Number, default: 0 },
    },
    { _id: false },
);

const totalsSchema = new mongoose.Schema(
    {
        received: { type: Number, default: 0 },
        inserted: { type: Number, default: 0 },
        duplicates: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
    },
    { _id: false },
);

const jobSyncRunSchema = new mongoose.Schema(
    {
        trigger: { type: String, enum: SYNC_TRIGGERS, required: true },
        triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        status: { type: String, enum: SYNC_STATUSES, required: true },
        startedAt: { type: Date, required: true },
        finishedAt: Date,
        durationMs: Number,
        results: { type: [resultSchema], default: [] },
        totals: { type: totalsSchema, default: () => ({}) },
        sampleJobsRemoved: { type: Number, default: 0 },
        error: String,
    },
    { timestamps: false, collection: "job_sync_runs" },
);

jobSyncRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: SYNC_RUN_TTL_SECONDS });
jobSyncRunSchema.index({ status: 1, startedAt: -1 });

export const JobSyncRun = mongoose.models.JobSyncRun || mongoose.model("JobSyncRun", jobSyncRunSchema);
export default JobSyncRun;
