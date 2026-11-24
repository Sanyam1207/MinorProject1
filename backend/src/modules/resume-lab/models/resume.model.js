// Unified Resume model (docs/contracts/RESUME-BYOK.md §2.1). One collection
// (`resumes`) holds the SIH Resume Bank versions and the Matchy LaTeX catalog.
// Editable text lives in MongoDB (`source`); only binaries go through the
// storage adapter (`original`, `pdf`).
//
// Registered WITHOUT a `mongoose.models.Resume ||` guard on purpose: nothing
// else may register "Resume" (models/resume.models.js re-exports this file).
import mongoose, { Schema } from "mongoose";

export const RESUME_KINDS = Object.freeze(["latex", "pdf", "docx", "text"]);
export const EDITABLE_KINDS = Object.freeze(["latex", "text"]);
export const RESUME_ORIGINS = Object.freeze(["generated", "uploaded", "created", "tailored", "duplicated"]);
export const LOCK_REASONS = Object.freeze(["alumni-share", "application", "manual"]);
export const STORAGE_DRIVER_NAMES = Object.freeze(["local", "cloudinary", "uploadthing"]);

// Control characters (except tab/newline handled by trim) are stripped from titles.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
export const cleanTitle = (value) => String(value ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();

const storedFileFields = {
    driver: { type: String, enum: STORAGE_DRIVER_NAMES, required: true },
    key: { type: String, required: true },
    contentType: { type: String },
    bytes: { type: Number },
    sha256: { type: String },
    originalName: { type: String },
    meta: { type: Schema.Types.Mixed },
};

const storedFileSchema = new Schema(storedFileFields, { _id: false });
const compiledPdfSchema = new Schema({
    ...storedFileFields,
    sourceHash: { type: String },
    compiledAt: { type: Date },
}, { _id: false });

const resumeSchema = new Schema({
    // Owner lookups use the {owner, version} / {owner, status, updatedAt} compound indexes; a plain
    // {owner:1} index would share its key pattern with owner_primary_unique.
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Student" },
    title: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        set: cleanTitle,
    },
    kind: { type: String, enum: RESUME_KINDS, required: true, default: "latex" },
    origin: { type: String, enum: RESUME_ORIGINS, default: "generated" },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    archivedAt: { type: Date },
    version: { type: Number, required: true, min: 1 },
    revision: { type: Number, default: 1 },
    isPrimary: { type: Boolean, default: false },
    source: { type: String, select: false },
    extractedText: { type: String, select: false, maxlength: 100_000 },
    sourceHash: { type: String, required: true },
    // UTF-8 size of `source` (latex/text), kept with it so lists need not load the source.
    sourceBytes: { type: Number, default: 0 },
    dedupeKey: { type: String },
    original: { type: storedFileSchema, default: undefined },
    pdf: { type: compiledPdfSchema, default: undefined },
    targetJob: { type: Schema.Types.Mixed, default: null },
    parent: { type: Schema.Types.ObjectId, ref: "Resume", default: null },
    lockedAt: { type: Date, default: null },
    lockReasons: { type: [{ type: String, enum: LOCK_REASONS }], default: [] },
    ats: {
        type: new Schema({
            score: Number,
            grade: String,
            sourceHash: String,
            scorerVersion: String,
            computedAt: Date,
        }, { _id: false }),
        default: undefined,
    },
    meta: {
        type: new Schema({
            pages: { type: Number, default: null },
            words: { type: Number, default: 0 },
            chars: { type: Number, default: 0 },
            truncated: { type: Boolean, default: false },
            extractionWarning: { type: String, default: null },
        }, { _id: false }),
        default: () => ({}),
    },
    // Legacy SIH Cloudinary record: read only by the migration, then $unset.
    storage: { type: Schema.Types.Mixed },
}, { timestamps: true, collection: "resumes" });

resumeSchema.index({ owner: 1, version: 1 }, { unique: true });
resumeSchema.index(
    { owner: 1, dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);
resumeSchema.index(
    { owner: 1 },
    { unique: true, partialFilterExpression: { isPrimary: true }, name: "owner_primary_unique" },
);
resumeSchema.index({ owner: 1, status: 1, updatedAt: -1 });
resumeSchema.index({ owner: 1, "original.sha256": 1 });

export const Resume = mongoose.model("Resume", resumeSchema);
