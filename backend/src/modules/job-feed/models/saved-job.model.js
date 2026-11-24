// SavedJob — a student's tracker entry for an open-market job
// (docs/contracts/JOB-FEED.md §2.2). Campus drives are never stored here.
import mongoose from "mongoose";
import { SAVED_JOB_STATUSES } from "../constants.js";

export const SAVED_JOB_HISTORY_MAX = 20;
export const SAVED_JOB_NOTES_MAX = 2000;

const historySchema = new mongoose.Schema(
    {
        status: { type: String, enum: SAVED_JOB_STATUSES },
        at: Date,
    },
    { _id: false },
);

// Copied from the job when the entry is created, so the tracker survives purges.
const snapshotSchema = new mongoose.Schema(
    {
        title: String,
        company: String,
        location: String,
        applyUrl: String,
        jobType: String,
        workType: String,
        salary: String,
        postedAt: Date,
        sources: { type: [String], default: [] },
    },
    { _id: false },
);

const savedJobSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        job: { type: mongoose.Schema.Types.ObjectId, ref: "ExternalJob", required: true },
        status: { type: String, enum: SAVED_JOB_STATUSES, default: "saved" },
        notes: { type: String, trim: true, maxlength: SAVED_JOB_NOTES_MAX, default: "" },
        appliedAt: { type: Date, default: null },
        statusChangedAt: { type: Date, required: true },
        history: { type: [historySchema], default: [] },
        snapshot: { type: snapshotSchema, default: () => ({}) },
    },
    { timestamps: true, collection: "saved_jobs" },
);

savedJobSchema.index({ user: 1, job: 1 }, { unique: true });
savedJobSchema.index({ user: 1, status: 1, updatedAt: -1 });
savedJobSchema.index({ job: 1 });

export const SavedJob = mongoose.models.SavedJob || mongoose.model("SavedJob", savedJobSchema);
export default SavedJob;
