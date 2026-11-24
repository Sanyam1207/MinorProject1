// Per-user pasted job descriptions (docs/contracts/RESUME-BYOK.md §2.2).
// Replaces Matchy writing a pasted JD into the SHARED job document: a student's
// text is visible only to that student and expires after 180 days.
import mongoose, { Schema } from "mongoose";

export const JD_MIN_CHARS = 30;
export const JD_MAX_CHARS = 20_000;

const overrideSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    jobSource: { type: String, enum: ["campus", "market"], required: true },
    jobId: { type: Schema.Types.ObjectId, required: true },
    text: { type: String, required: true, trim: true, minlength: JD_MIN_CHARS, maxlength: JD_MAX_CHARS },
    textHash: { type: String },
}, { timestamps: true, collection: "job_description_overrides" });

overrideSchema.index({ user: 1, jobSource: 1, jobId: 1 }, { unique: true });
overrideSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 15_552_000 });

export const JobDescriptionOverride = mongoose.models.JobDescriptionOverride
    || mongoose.model("JobDescriptionOverride", overrideSchema);
