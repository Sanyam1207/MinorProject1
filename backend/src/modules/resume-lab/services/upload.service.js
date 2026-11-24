// Uploads (docs/contracts/RESUME-BYOK.md §4, §8.1): multer in memory, content
// sniffing, deduplication and creation of `origin: "uploaded"` resumes.
import crypto from "node:crypto";
import path from "node:path";
import multer from "multer";
import { fail } from "../../../core/http.js";
import { maxSourceBytes, maxUploadBytes } from "../config.js";
import { EDITABLE_KINDS, Resume, cleanTitle } from "../models/resume.model.js";
import { deleteStoredFile, getStorage } from "../storage/index.js";
import { describeText, sniffAndExtract } from "./extract.service.js";
import { createResume, emitResumeChanged, setPrimaryInternal } from "./resume.service.js";

/** "true"/"false"/booleans/1/0 → boolean; anything else → fallback. */
export const parseBool = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(text)) return true;
    if (["false", "0", "no", "off"].includes(text)) return false;
    return fallback;
};

/**
 * Multipart parser for `resume` (legacy) or `file`, with limits read at call
 * time and multer errors mapped to the envelope codes. Non-multipart requests
 * pass through untouched (JSON bodies).
 */
export const resumeUpload = (req, res, next) => {
    if (!req.is("multipart/form-data")) return next();
    const parser = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxUploadBytes(), files: 1, fields: 10, fieldSize: maxSourceBytes() + 1024 },
    }).fields([{ name: "resume", maxCount: 1 }, { name: "file", maxCount: 1 }]);
    return parser(req, res, (error) => {
        if (!error) {
            req.body ||= {};
            return next();
        }
        if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                const megabytes = (maxUploadBytes() / (1024 * 1024)).toFixed(maxUploadBytes() >= 1024 * 1024 ? 0 : 2);
                return next(fail(413, `The file is too large (at most ${megabytes} MB)`, "FILE_TOO_LARGE"));
            }
            if (error.code === "LIMIT_FIELD_VALUE") {
                return next(fail(413, "The pasted resume text is too large", "SOURCE_TOO_LARGE"));
            }
            return next(fail(400, `Invalid upload: ${error.message}`, "VALIDATION", error.field ? { field: error.field } : {}));
        }
        return next(fail(400, "The upload could not be read (malformed multipart body)", "VALIDATION"));
    });
};

export const pickUploadedFile = (req) => req.files?.resume?.[0] || req.files?.file?.[0] || null;

const assertTextSize = (text) => {
    if (Buffer.byteLength(text, "utf8") > maxSourceBytes()) {
        throw fail(413, `The resume text is too large (at most ${Math.round(maxSourceBytes() / 1024)} KB)`, "SOURCE_TOO_LARGE");
    }
};

const defaultTitleFor = (file) => {
    if (!file) return "Pasted resume";
    const name = path.parse(String(file.originalname || "")).name;
    return cleanTitle(name.replace(/[_]+/g, " ")).slice(0, 200) || "Uploaded resume";
};

/**
 * Create (or find) a resume from an uploaded file or pasted text.
 * @returns {Promise<{resume: object, created: boolean}>} lean resume
 */
export const createFromUpload = async (user, { file = null, text, title, makePrimary = true, origin = "uploaded", targetJob = null } = {}) => {
    let described;
    if (file?.buffer) {
        described = await sniffAndExtract(file.buffer, { filename: file.originalname });
    } else if (typeof text === "string" && text.trim()) {
        assertTextSize(text);
        described = describeText(text);
    } else {
        throw fail(400, "Upload a resume file (PDF, DOCX, TEX or TXT) or paste its text", "VALIDATION", { field: "resume" });
    }
    const editable = EDITABLE_KINDS.includes(described.kind);
    if (editable) assertTextSize(described.source);

    const duplicateFilter = editable
        ? { owner: user._id, status: "active", kind: described.kind, sourceHash: described.sha256 }
        : { owner: user._id, status: "active", "original.sha256": described.sha256 };
    const existing = await Resume.findOne(duplicateFilter).lean();
    if (existing) {
        if (makePrimary && !existing.isPrimary) {
            await setPrimaryInternal(user._id, existing._id);
            const fresh = await Resume.findById(existing._id).lean();
            await emitResumeChanged(user._id, "primary", fresh);
            return { resume: fresh, created: false };
        }
        return { resume: existing, created: false };
    }

    let original;
    if (!editable) {
        const stored = await getStorage().put(
            `resumes/${user._id}/${crypto.randomUUID()}.${described.extension}`,
            file.buffer,
            { contentType: described.contentType, originalName: cleanTitle(file.originalname).slice(0, 200) || undefined },
        );
        original = { ...stored, sha256: described.sha256 };
    }

    const requestedTitle = typeof title === "string" && cleanTitle(title) ? cleanTitle(title) : null;
    try {
        return await createResume({
            owner: user._id,
            kind: described.kind,
            origin,
            title: requestedTitle || defaultTitleFor(file),
            source: editable ? described.source : undefined,
            extractedText: described.extractedText,
            meta: described.meta,
            sourceHash: described.sha256,
            original,
            targetJob,
        }, { user, makePrimary });
    } catch (error) {
        if (original) await deleteStoredFile(original);
        throw error;
    }
};
