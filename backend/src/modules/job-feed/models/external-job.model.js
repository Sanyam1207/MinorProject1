// ExternalJob — an open-market job aggregated from external sources
// (docs/contracts/JOB-FEED.md §2.1). Read-only for every other module: only the
// job-feed module (ingest, upsert, purge, sample cleanup) writes it.
import mongoose from "mongoose";
import { JOB_TYPES, WORK_TYPES } from "../constants.js";

const sourceSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        externalId: { type: String, required: true },
    },
    { _id: false },
);

const externalJobSchema = new mongoose.Schema(
    {
        dedupeKey: { type: String, required: true, unique: true },
        title: { type: String, trim: true, maxlength: 300 },
        company: { type: String, trim: true, maxlength: 200 },
        companyLogo: String,
        location: { type: String, trim: true, maxlength: 200 },
        experience: { type: String, trim: true, maxlength: 100 },
        salary: { type: String, trim: true, maxlength: 100 },
        jobType: { type: String, enum: JOB_TYPES },
        workType: { type: String, enum: WORK_TYPES },
        // Cleaned; tracking parameters are kept (only the dedupe key ignores them).
        applyUrl: String,
        description: { type: String, maxlength: 10000 },
        // Newest posting date seen, so a repost bubbles up.
        postedAt: { type: Date, required: true },
        lastSeenAt: { type: Date, required: true },
        sources: { type: [sourceSchema], default: [] },
        // Lowercase fields of work, e.g. "developer", "data-analyst".
        categories: { type: [String], default: [] },
        isSample: { type: Boolean, default: false },
    },
    { timestamps: true, collection: "external_jobs" },
);

externalJobSchema.index({ postedAt: -1, _id: -1 });
externalJobSchema.index({ jobType: 1, postedAt: -1 });
externalJobSchema.index({ categories: 1, postedAt: -1 });
externalJobSchema.index({ "sources.name": 1, postedAt: -1 });
externalJobSchema.index({ lastSeenAt: 1 });
externalJobSchema.index({ isSample: 1 });

export const ExternalJob = mongoose.models.ExternalJob || mongoose.model("ExternalJob", externalJobSchema);
export default ExternalJob;
