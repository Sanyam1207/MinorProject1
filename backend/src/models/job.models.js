// Campus drive (docs/contracts/PLACEMENTS.md §3.1). Model `Job`, collection `jobs`.
//
// Applications live in their own collection (modules/placements/models/application.model.js);
// the legacy embedded `applications` array is migrated away on boot (§3.8) and never written.
import mongoose, { Schema } from "mongoose";

const RoundSchema = new Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    at: { type: Date, default: null },
    venue: { type: String, trim: true, maxlength: 200, default: "" },
    mode: { type: String, enum: ["online", "offline"], default: "offline" },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
});

const ReviewSchema = new Schema({
    decision: { type: String, enum: ["approved", "rejected"] },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    byName: { type: String, trim: true, maxlength: 200 },
    at: { type: Date },
    note: { type: String, trim: true, maxlength: 500, default: "" },
}, { _id: false });

const JobSchema = new Schema({
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, required: true, maxlength: 20000 },
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    companyLogo: { type: String, trim: true, maxlength: 500 },
    // Display text as entered ("18 LPA", "₹12–15 lakh"); packageLpa/packageMaxLpa are the parsed bounds.
    salary: { type: String, default: "not disclosed", maxlength: 100 },
    packageLpa: { type: Number, min: 0, max: 500, default: null },
    packageMaxLpa: { type: Number, min: 0, max: 500, default: null },
    eligibleBranches: { type: [String], default: [] },
    location: { type: String, default: "", maxlength: 200 },
    employmentType: { type: String, default: "", maxlength: 60 },
    minimumCgpa: { type: Number, min: 0, max: 10 },
    maximumBacklogs: { type: Number, min: 0, max: 50 },
    min10thPercentage: { type: Number, min: 0, max: 100 },
    min12thPercentage: { type: Number, min: 0, max: 100 },
    graduationYears: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    selectionProcess: { type: String, default: "", maxlength: 5000 },
    rounds: {
        type: [RoundSchema],
        default: [],
        validate: { validator: (rounds) => !Array.isArray(rounds) || rounds.length <= 10, message: "At most 10 rounds" },
    },
    // Required for new drives (validated by the service so legacy documents still load).
    applicationDeadline: { type: Date },
    driveDate: { type: Date, default: null },
    status: {
        type: String,
        enum: ["draft", "pending", "active", "closed", "rejected"],
        default: "active",
        index: true,
    },
    college: { type: Schema.Types.ObjectId, ref: "College", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByRole: { type: String, enum: ["tpo", "admin", "company"], default: "tpo" },
    // AI job-creator chat session + per-draft idempotency key (§8).
    sourceSessionId: { type: String },
    sourceDraftKey: { type: String },
    review: { type: ReviewSchema, default: undefined },
    publishedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    closedReason: { type: String, enum: ["manual", "deadline", null], default: null },
    // Claimed atomically when the drive.new fan-out runs, so a drive is announced at most once.
    notifiedAt: { type: Date, default: null },
    deadlineReminderSentAt: { type: Date, default: null },
}, {
    timestamps: true,
});

// One document per AI-created draft (fixes the old one-job-per-chat-session overwrite).
JobSchema.index(
    { createdBy: 1, sourceSessionId: 1, sourceDraftKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            createdBy: { $type: "objectId" },
            sourceSessionId: { $type: "string" },
            sourceDraftKey: { $type: "string" },
        },
    },
);
JobSchema.index({ college: 1, status: 1, applicationDeadline: 1 });
JobSchema.index({ company: 1, status: 1 });
JobSchema.index({ status: 1, applicationDeadline: 1 });

export const Job = mongoose.models.Job || mongoose.model("Job", JobSchema, "jobs");
