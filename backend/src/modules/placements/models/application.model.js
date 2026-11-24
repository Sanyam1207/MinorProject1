// Application to a campus drive (docs/contracts/PLACEMENTS.md §3.2). Collection `applications`.
import mongoose, { Schema } from "mongoose";
import { Job } from "../../../models/job.models.js";
import {
    APPLICATION_SOURCES,
    APPLICATION_STATUSES,
    ELIGIBILITY_SNAPSHOT_STATUSES,
} from "../constants.js";
import { academicYearFor } from "../services/academic-year.js";
import { clock } from "../utils/dates.js";

const TimelineEntrySchema = new Schema({
    status: { type: String, enum: APPLICATION_STATUSES, required: true },
    at: { type: Date, default: () => clock.now() },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byRole: { type: String, default: "" },
    byName: { type: String, default: "" },
    // Visible to the student.
    note: { type: String, maxlength: 500, default: "" },
}, { _id: false });

const CheckSchema = new Schema({
    key: String,
    label: String,
    required: String,
    actual: { type: String, default: null },
    passed: { type: Boolean, default: null },
}, { _id: false });

const SnapshotSchema = new Schema({
    eligible: { type: Boolean, default: null },
    status: { type: String, enum: ELIGIBILITY_SNAPSHOT_STATUSES, default: "unknown" },
    code: { type: String, default: null },
    reasons: { type: [String], default: [] },
    missing: { type: [String], default: [] },
    checks: { type: [CheckSchema], default: [] },
    policy: {
        enforced: Boolean,
        blocked: Boolean,
        currentAcceptedPackage: { type: Number, default: null },
        requiredPackageLpa: { type: Number, default: null },
        isDreamUpgrade: Boolean,
    },
    profile: {
        cgpa: { type: Number, default: null },
        activeBacklogs: { type: Number, default: null },
        branch: { type: String, default: null },
        passingYear: { type: String, default: null },
        tenthPercentage: { type: Number, default: null },
        twelfthPercentage: { type: Number, default: null },
        verified: { type: Boolean, default: false },
    },
    evaluatedAt: { type: Date, default: null },
}, { _id: false });

const ApplicationSchema = new Schema({
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    college: { type: Schema.Types.ObjectId, ref: "College", default: null, index: true },
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    academicYear: { type: String, required: true },
    status: { type: String, enum: APPLICATION_STATUSES, default: "applied", index: true },
    timeline: { type: [TimelineEntrySchema], default: undefined },
    resume: {
        type: new Schema({
            id: { type: Schema.Types.ObjectId, ref: "Resume" },
            title: { type: String, default: "" },
            version: { type: Number, default: null },
        }, { _id: false }),
        default: null,
    },
    coverNote: { type: String, maxlength: 2000, default: "" },
    eligibilitySnapshot: { type: SnapshotSchema, default: undefined },
    eligibilityOverride: {
        type: new Schema({
            by: { type: Schema.Types.ObjectId, ref: "User" },
            byName: String,
            at: Date,
            note: { type: String, maxlength: 500 },
        }, { _id: false }),
        default: null,
    },
    source: { type: String, enum: APPLICATION_SOURCES, default: "web" },
    offer: { type: Schema.Types.ObjectId, ref: "Offer", default: null },
    appliedAt: { type: Date, default: () => clock.now() },
    withdrawnAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
}, { timestamps: true });

ApplicationSchema.index({ job: 1, student: 1 }, { unique: true });
ApplicationSchema.index({ student: 1, appliedAt: -1 });
ApplicationSchema.index({ job: 1, status: 1 });
ApplicationSchema.index({ college: 1, academicYear: 1, status: 1 });
ApplicationSchema.index({ company: 1, status: 1 });

// Seeds and migrations may omit the derived fields; fill them here (Mongoose 9: no `next`).
ApplicationSchema.pre("validate", async function fillDerivedFields() {
    if (!this.academicYear) this.academicYear = academicYearFor(this.appliedAt ?? clock.now());
    if (this.job && (!this.company || (this.isNew && this.college == null))) {
        const job = await Job.findById(this.job).select("company college").lean();
        if (job) {
            if (!this.company) this.company = job.company;
            if (this.college === undefined || this.college === null) this.college = job.college ?? null;
        }
    }
    if (!Array.isArray(this.timeline) || this.timeline.length === 0) {
        this.timeline = [{ status: this.status || "applied", at: this.appliedAt ?? clock.now(), byRole: "system", byName: "" }];
    }
});

export const Application = mongoose.models.Application || mongoose.model("Application", ApplicationSchema, "applications");
