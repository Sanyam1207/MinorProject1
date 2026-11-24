// Issue reports (docs/contracts/AUTH-FACULTY.md §2.4), ported from Matchy's
// models/issue-report.model.js and extended with reporter identity, college
// scope and a triage workflow.
import mongoose, { Schema } from "mongoose";

export const ISSUE_STATUSES = Object.freeze(["open", "in_progress", "resolved", "closed"]);
export const ISSUE_LIMITS = Object.freeze({ name: 120, email: 254, description: 5000, page: 300, userAgent: 300, note: 2000 });

const IssueReportSchema = new Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: ISSUE_LIMITS.name },
        email: { type: String, required: true, trim: true, lowercase: true, maxlength: ISSUE_LIMITS.email },
        description: { type: String, required: true, trim: true, maxlength: ISSUE_LIMITS.description },
        // Screen or feature where it happened.
        page: { type: String, trim: true, maxlength: ISSUE_LIMITS.page, default: "" },
        // Set when the reporter was signed in.
        user: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
        role: { type: String, default: null },
        college: { type: Schema.Types.ObjectId, ref: "College", default: null, index: true },
        userAgent: { type: String, maxlength: ISSUE_LIMITS.userAgent },
        status: { type: String, enum: ISSUE_STATUSES, default: "open", index: true },
        // Triage note by the TPO or an admin.
        note: { type: String, maxlength: ISSUE_LIMITS.note },
        resolvedAt: { type: Date },
        handledBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    { timestamps: true, collection: "issue_reports" },
);

IssueReportSchema.index({ createdAt: -1 });
IssueReportSchema.index({ status: 1, createdAt: -1 });
IssueReportSchema.index({ college: 1, createdAt: -1 });

export const IssueReport = mongoose.models.IssueReport || mongoose.model("IssueReport", IssueReportSchema);
