// Resume catalog service (docs/contracts/RESUME-BYOK.md §2, §5, §8, §13).
//
// Owns every write to `resumes`: versions, primary, lock, edits, duplicates,
// apply-patches, generic ATS scores, compiled-PDF caching and the compat
// exports used by the alumni flow, the Python metadata builder and placements.
// Every mutation emits `resume:changed` to the owner's socket room.
import crypto from "node:crypto";
import mongoose from "mongoose";
import { escapeRegex, fail, isObjectId } from "../../../core/http.js";
import { createLimiter } from "../../../core/rate-limit.js";
import { emitToUser } from "../../../core/realtime.js";
import { SCORER_VERSION, scoreResume } from "../ats/scorer.js";
import { LIST_LIMIT, TARGET_JOB_MAX_BYTES, maxResumesPerUser, maxSourceBytes } from "../config.js";
import { compileLatex } from "../latex/compiler.js";
import { JobDescriptionOverride } from "../models/job-description-override.model.js";
import { EDITABLE_KINDS, LOCK_REASONS, RESUME_KINDS, Resume, cleanTitle } from "../models/resume.model.js";
import { deleteStoredFile, getStorage, storageFor } from "../storage/index.js";
import { CONTENT_TYPES, describeText, sha256Hex } from "./extract.service.js";
import { applyLocatedPatches, locatePatchesForApply } from "./patches.js";
import { publicJob, resolveJob, resolveJobDescription } from "./job-ref.service.js";

const RESUME_EVENT = "resume:changed";
const isEditableKind = (kind) => EDITABLE_KINDS.includes(kind);
const kindOf = (doc) => doc?.kind || "latex";

// ── serializers ─────────────────────────────────────────────────────────────

const plain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject({ depopulate: true }) : doc);

const sizeOf = (doc) => (isEditableKind(kindOf(doc)) ? Number(doc.sourceBytes) || 0 : Number(doc.original?.bytes) || 0);

/** ResumeSummary (§2.5). Never exposes source, extractedText, hashes or storage keys. */
export const serializeSummary = (input) => {
    const doc = plain(input);
    if (!doc) return null;
    const kind = kindOf(doc);
    const status = doc.status || "active";
    const locked = Boolean(doc.lockedAt);
    const sizeBytes = sizeOf(doc);
    return {
        _id: String(doc._id),
        id: String(doc._id),
        title: doc.title,
        kind,
        origin: doc.origin || "generated",
        status,
        version: doc.version,
        revision: doc.revision || 1,
        isPrimary: Boolean(doc.isPrimary),
        locked,
        editable: isEditableKind(kind) && !locked && status === "active",
        hasPdf: kind === "pdf" || kind === "latex",
        sizeBytes,
        contentType: CONTENT_TYPES[kind],
        targetJob: doc.targetJob ?? null,
        parentId: doc.parent ? String(doc.parent) : null,
        atsScore: doc.ats && doc.ats.sourceHash && doc.ats.sourceHash === doc.sourceHash ? doc.ats.score : null,
        extractionWarning: doc.meta?.extractionWarning ?? null,
        storage: { bytes: sizeBytes },
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
};

/** ResumeDetail = ResumeSummary + meta. */
export const serializeDetail = (input) => {
    const doc = plain(input);
    if (!doc) return null;
    const meta = doc.meta || {};
    return {
        ...serializeSummary(doc),
        meta: {
            pages: meta.pages ?? null,
            words: meta.words ?? 0,
            chars: meta.chars ?? 0,
            truncated: Boolean(meta.truncated),
        },
    };
};

/** BankItem (SIH Resume Bank shape). */
export const serializeBankItem = (input) => {
    const doc = plain(input);
    if (!doc) return null;
    return {
        _id: String(doc._id),
        title: doc.title,
        version: doc.version,
        targetJob: doc.targetJob ?? null,
        status: doc.status || "active",
        kind: kindOf(doc),
        isPrimary: Boolean(doc.isPrimary),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        storage: { bytes: sizeOf(doc) },
    };
};

/** Snapshot stored on alumni share messages. */
export const resumeSnapshot = (resume) => ({
    title: resume.title,
    version: resume.version,
    targetJob: resume.targetJob ?? null,
    kind: kindOf(resume),
});

// ── helpers ────────────────────────────────────────────────────────────────

const notFound = () => fail(404, "Resume not found", "NOT_FOUND", { entity: "resume" });

const assertResumeId = (value) => {
    if (!isObjectId(String(value ?? ""))) throw fail(400, "id must be a valid id", "VALIDATION", { field: "id" });
    return String(value);
};

const profileSkills = (user) => (Array.isArray(user?.skills) ? user.skills.filter((skill) => typeof skill === "string") : []);

/** Generic (no-job) ATS record stored on the resume. */
const genericAts = ({ extractedText, kind, meta, sourceHash, user }) => {
    const result = scoreResume({
        text: extractedText || "",
        kind,
        pages: meta?.pages ?? null,
        profile: { skills: profileSkills(user) },
        job: null,
        jobText: null,
    });
    return { score: result.score, grade: result.grade, sourceHash, scorerVersion: SCORER_VERSION, computedAt: new Date() };
};

/** Truncate long strings (> 4 000 chars) and cap the whole value at 16 KB of JSON. */
export const cleanTargetJob = (value) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "object" && typeof value !== "string") {
        throw fail(400, "targetJob must be an object", "VALIDATION", { field: "targetJob" });
    }
    const trim = (input, depth) => {
        if (typeof input === "string") return input.length > 4000 ? input.slice(0, 4000) : input;
        if (Array.isArray(input)) return depth > 5 ? [] : input.map((item) => trim(item, depth + 1));
        if (input && typeof input === "object") {
            if (depth > 5) return {};
            const out = {};
            for (const [key, item] of Object.entries(input)) {
                if (key.startsWith("$") || key.includes(".")) continue;
                out[key] = trim(item, depth + 1);
            }
            return out;
        }
        return input;
    };
    const cleaned = trim(value, 0);
    if (Buffer.byteLength(JSON.stringify(cleaned), "utf8") > TARGET_JOB_MAX_BYTES) {
        throw fail(400, "targetJob is too large (at most 16 KB)", "VALIDATION", { field: "targetJob" });
    }
    return cleaned;
};

const assertSourceSize = (source) => {
    if (Buffer.byteLength(source, "utf8") > maxSourceBytes()) {
        throw fail(413, `The resume source is too large (at most ${Math.round(maxSourceBytes() / 1024)} KB)`, "SOURCE_TOO_LARGE");
    }
};

const compileLimiter = createLimiter({ windowMs: 60_000, max: 20 });

/** Shared compile budget per user (20/min), including on-demand PDF compiles. */
export const assertCompileAllowed = (userId) => {
    if (process.env.NODE_ENV === "test" && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== "true") return;
    if (!compileLimiter.hit(`compile:${String(userId || "anonymous")}`)) {
        throw fail(429, "Too many compiles. Please wait a minute and try again.", "TOO_MANY_ATTEMPTS");
    }
};

export const currentPrimaryId = async (ownerId) => {
    const primary = await Resume.findOne({ owner: ownerId, isPrimary: true }).select("_id").lean();
    return primary ? String(primary._id) : null;
};

const emitChanged = async (ownerId, action, resume, resumeId = resume?._id) => {
    try {
        const primaryId = await currentPrimaryId(ownerId);
        emitToUser(ownerId, RESUME_EVENT, {
            action,
            resumeId: resumeId ? String(resumeId) : null,
            resume: resume ? serializeSummary(resume) : null,
            primaryId,
        });
        return primaryId;
    } catch (error) {
        console.warn(`[resume-lab] could not emit ${RESUME_EVENT}: ${error?.message || error}`);
        return null;
    }
};

/**
 * Promotion rule: when the owner has active resumes but no (active) primary, the
 * most recently updated active resume becomes primary. Returns the primary id.
 */
export const ensurePrimary = async (ownerId) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = await Resume.findOne({ owner: ownerId, isPrimary: true }).select("_id status").lean();
        if (existing) {
            if (existing.status === "active") return String(existing._id);
            await Resume.updateOne({ _id: existing._id }, { $set: { isPrimary: false } }, { timestamps: false });
            continue;
        }
        const candidate = await Resume.findOne({ owner: ownerId, status: "active" })
            .sort({ updatedAt: -1, _id: -1 }).select("_id").lean();
        if (!candidate) return null;
        try {
            const result = await Resume.updateOne(
                { _id: candidate._id, status: "active" },
                { $set: { isPrimary: true } },
                { timestamps: false },
            );
            if (result.matchedCount) return String(candidate._id);
        } catch (error) {
            if (error?.code !== 11000) throw error;
        }
    }
    return currentPrimaryId(ownerId);
};

const assertBelowLimit = async (ownerId) => {
    const limit = maxResumesPerUser();
    const active = await Resume.countDocuments({ owner: ownerId, status: "active" });
    if (active >= limit) {
        throw fail(409, `You can keep at most ${limit} active resumes. Delete or archive one first.`, "RESUME_LIMIT", { limit });
    }
};

const nextVersion = async (ownerId) => {
    const latest = await Resume.findOne({ owner: ownerId }).sort({ version: -1 }).select("version").lean();
    return (Number(latest?.version) || 0) + 1;
};

// ── reads ──────────────────────────────────────────────────────────────────

/** An owned resume (lean) or 404. `select` adds hidden fields, e.g. "+source". */
export const getResumeForOwner = async (ownerId, resumeId, { select = "" } = {}) => {
    const id = assertResumeId(resumeId);
    const query = Resume.findOne({ _id: id, owner: ownerId });
    if (select) query.select(select);
    const resume = await query.lean();
    if (!resume) throw notFound();
    return resume;
};

/** The primary resume, else the most recently updated active one, else null. */
export const getPrimaryResume = async (ownerId, { select = "" } = {}) => {
    const primaryQuery = Resume.findOne({ owner: ownerId, isPrimary: true, status: "active" });
    if (select) primaryQuery.select(select);
    const primary = await primaryQuery.lean();
    if (primary) return primary;
    const newestQuery = Resume.findOne({ owner: ownerId, status: "active" }).sort({ updatedAt: -1, _id: -1 });
    if (select) newestQuery.select(select);
    return newestQuery.lean();
};

export const listResumes = async (ownerId, { status = "active", kind } = {}) => {
    const statusValue = String(status || "active").toLowerCase();
    if (!["active", "archived", "all"].includes(statusValue)) {
        throw fail(400, "status must be active, archived or all", "VALIDATION", { field: "status" });
    }
    const filter = { owner: ownerId };
    if (statusValue !== "all") filter.status = statusValue;
    if (kind !== undefined && kind !== "") {
        const kindValue = String(kind).toLowerCase();
        if (!RESUME_KINDS.includes(kindValue)) throw fail(400, `kind must be one of ${RESUME_KINDS.join(", ")}`, "VALIDATION", { field: "kind" });
        filter.kind = kindValue;
    }
    const docs = await Resume.find(filter).sort({ isPrimary: -1, updatedAt: -1, _id: -1 }).limit(LIST_LIMIT).lean();
    return { resumes: docs.map(serializeSummary), primaryId: await currentPrimaryId(ownerId), limit: maxResumesPerUser() };
};

/** `{resume: ResumeDetail, content, contentKind}`. */
export const getResumeDetail = async (ownerId, resumeId) => {
    const resume = await getResumeForOwner(ownerId, resumeId, { select: "+source +extractedText" });
    const kind = kindOf(resume);
    const editable = isEditableKind(kind);
    return {
        resume: serializeDetail(resume),
        content: editable ? (resume.source ?? "") : (resume.extractedText ?? ""),
        contentKind: editable ? kind : "extracted",
    };
};

/** BankItem[] of active resumes of every kind, version descending. */
export const listResumeMetadata = async (ownerId) => {
    const docs = await Resume.find({ owner: ownerId, status: "active" }).sort({ version: -1 }).limit(LIST_LIMIT).lean();
    return docs.map(serializeBankItem);
};

/** For the Python resume agent: the primary (else newest active) resume with its text. */
export const getLatestResumeForAnalysis = async (ownerId) => {
    const resume = await getPrimaryResume(ownerId, { select: "+source +extractedText" });
    if (!resume) return null;
    return {
        _id: resume._id,
        title: resume.title,
        version: resume.version,
        targetJob: resume.targetJob ?? null,
        kind: kindOf(resume),
        createdAt: resume.createdAt,
        latexCode: resume.source ?? resume.extractedText ?? "",
    };
};

const resumeLabel = (resume) => `${resume.title} · v${resume.version} · ${kindOf(resume).toUpperCase()}`;

/**
 * Fuzzy resume reference for agent tools: an owned id, primary/main/default,
 * latest, or a case-insensitive title match among active resumes.
 * @returns {Promise<object|{ambiguous:true, message, candidates}>} lean resume
 */
export const resolveResumeRef = async (user, ref, { select = "" } = {}) => {
    const text = typeof ref === "string" ? ref.trim() : "";
    const lower = text.toLowerCase();
    if (!text || ["primary", "main", "default"].includes(lower)) {
        const resume = await getPrimaryResume(user._id, { select });
        if (!resume) throw notFound();
        return resume;
    }
    if (isObjectId(text)) return getResumeForOwner(user._id, text, { select });
    if (lower === "latest") {
        const query = Resume.findOne({ owner: user._id, status: "active" }).sort({ version: -1 });
        if (select) query.select(select);
        const resume = await query.lean();
        if (!resume) throw notFound();
        return resume;
    }
    const query = Resume.find({ owner: user._id, status: "active", title: new RegExp(escapeRegex(text), "i") })
        .sort({ isPrimary: -1, updatedAt: -1 }).limit(10);
    if (select) query.select(select);
    const matches = await query.lean();
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
        const exact = matches.filter((resume) => resume.title.toLowerCase() === lower);
        if (exact.length === 1) return exact[0];
        return {
            ambiguous: true,
            message: "Which resume?",
            candidates: matches.map((resume) => ({ id: String(resume._id), label: resumeLabel(resume) })),
        };
    }
    throw fail(404, `No resume matches '${text}'`, "NOT_FOUND", { entity: "resume" });
};

// ── create ─────────────────────────────────────────────────────────────────

/**
 * Insert a resume with the next per-owner version (retried on E11000).
 * `fields` carries kind/origin/title/source/extractedText/meta/sourceHash/...
 * @returns {Promise<{resume: object, created: boolean}>} lean resume
 */
export const createResume = async (fields, { user = null, makePrimary = false, emit = true } = {}) => {
    const owner = fields.owner;
    await assertBelowLimit(owner);
    const kind = fields.kind;
    const source = isEditableKind(kind) ? fields.source : undefined;
    const doc = {
        _id: fields._id || new mongoose.Types.ObjectId(),
        owner,
        ...(user?.student ? { createdBy: user.student._id || user.student } : {}),
        title: cleanTitle(fields.title).slice(0, 200) || "Untitled resume",
        kind,
        origin: fields.origin,
        status: "active",
        revision: 1,
        isPrimary: false,
        ...(source !== undefined ? { source, sourceBytes: Buffer.byteLength(source, "utf8") } : {}),
        extractedText: fields.extractedText || "",
        sourceHash: fields.sourceHash,
        ...(fields.dedupeKey ? { dedupeKey: fields.dedupeKey } : {}),
        ...(fields.original ? { original: fields.original } : {}),
        ...(fields.pdf ? { pdf: fields.pdf } : {}),
        targetJob: fields.targetJob ?? null,
        parent: fields.parent ?? null,
        meta: fields.meta || {},
        ats: genericAts({ extractedText: fields.extractedText, kind, meta: fields.meta, sourceHash: fields.sourceHash, user }),
    };

    let created = null;
    for (let attempt = 0; attempt < 4 && !created; attempt += 1) {
        try {
            created = await Resume.create({ ...doc, version: await nextVersion(owner) });
        } catch (error) {
            if (error?.code === 11000 && error.keyPattern?.dedupeKey) {
                const existing = await Resume.findOne({ owner, dedupeKey: fields.dedupeKey }).lean();
                if (existing) return { resume: existing, created: false };
            }
            if (error?.code === 11000 && error.keyPattern?.version && attempt < 3) continue;
            throw error;
        }
    }

    if (makePrimary) await setPrimaryInternal(owner, created._id);
    else await ensurePrimary(owner);
    const resume = await Resume.findById(created._id).lean();
    if (emit) await emitChanged(owner, "created", resume);
    return { resume, created: true };
};

/** Pasted / JSON-created latex or text resume (POST /resumes JSON). Deduplicated by source among active resumes. */
export const createFromContent = async (user, { title, kind, content, makePrimary = true, targetJob, origin = "created" } = {}) => {
    if (typeof content !== "string" || !content.trim()) throw fail(400, "content is required", "VALIDATION", { field: "content" });
    if (kind !== undefined && kind !== null && kind !== "" && !isEditableKind(String(kind))) {
        throw fail(400, "kind must be latex or text", "VALIDATION", { field: "kind" });
    }
    const source = content.replace(/\r\n?/g, "\n");
    assertSourceSize(source);
    const described = describeText(source, { kind: kind || null });
    const cleanedTarget = cleanTargetJob(targetJob);
    const existing = await Resume.findOne({
        owner: user._id, status: "active", kind: described.kind, sourceHash: described.sha256,
    }).lean();
    if (existing) {
        if (makePrimary) await setPrimaryInternal(user._id, existing._id);
        const resume = await Resume.findById(existing._id).lean();
        if (makePrimary && !existing.isPrimary) await emitChanged(user._id, "primary", resume);
        return { resume, created: false };
    }
    const defaultTitle = described.kind === "latex" ? "LaTeX resume" : "Text resume";
    return createResume({
        owner: user._id,
        kind: described.kind,
        origin,
        title: title === undefined || title === null || !cleanTitle(title) ? defaultTitle : title,
        source: described.source,
        extractedText: described.extractedText,
        meta: described.meta,
        sourceHash: described.sha256,
        targetJob: cleanedTarget,
    }, { user, makePrimary: makePrimary !== false });
};

// ── primary / lock ─────────────────────────────────────────────────────────

const setPrimaryInternal = async (ownerId, resumeId) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await Resume.updateMany(
            { owner: ownerId, isPrimary: true, _id: { $ne: resumeId } },
            { $set: { isPrimary: false } },
            { timestamps: false },
        );
        try {
            const result = await Resume.updateOne(
                { _id: resumeId, owner: ownerId, status: "active" },
                { $set: { isPrimary: true } },
                { timestamps: false },
            );
            if (!result.matchedCount) throw fail(409, "Archived resumes can't be primary. Restore it first.", "RESUME_ARCHIVED");
            return;
        } catch (error) {
            if (error?.code === 11000 && attempt === 0) continue;
            throw error;
        }
    }
};

/** POST /resumes/:id/primary → {resume, previousPrimaryId}. */
export const setPrimary = async (ownerId, resumeId) => {
    const resume = await getResumeForOwner(ownerId, resumeId);
    if (resume.status !== "active") throw fail(409, "Archived resumes can't be primary. Restore it first.", "RESUME_ARCHIVED");
    const previousPrimaryId = await currentPrimaryId(ownerId);
    if (previousPrimaryId !== String(resume._id)) {
        await setPrimaryInternal(ownerId, resume._id);
    }
    const updated = await Resume.findById(resume._id).lean();
    if (previousPrimaryId !== String(resume._id)) await emitChanged(ownerId, "primary", updated);
    return { resume: serializeSummary(updated), previousPrimaryId };
};

/** Lock a resume (idempotent). Its source can never change afterwards. */
export const lockResume = async (resumeId, reason = "manual") => {
    if (!LOCK_REASONS.includes(reason)) throw new TypeError(`lockResume: unknown reason "${reason}"`);
    const id = assertResumeId(resumeId);
    await Resume.updateOne({ _id: id, lockedAt: null }, { $set: { lockedAt: new Date() } }, { timestamps: false });
    const updated = await Resume.findOneAndUpdate(
        { _id: id },
        { $addToSet: { lockReasons: reason } },
        { new: true, timestamps: false },
    ).lean();
    if (!updated) return null;
    await emitChanged(updated.owner, "locked", updated);
    return updated;
};

// ── update / delete / restore / duplicate ──────────────────────────────────

const revisionConflict = (currentRevision) =>
    fail(409, "This resume changed since you opened it. Reload it and try again.", "REVISION_CONFLICT", { currentRevision });

/** PUT/PATCH /resumes/:id → ResumeSummary. */
export const updateResume = async (user, resumeId, body = {}) => {
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
    if (!has("title") && !has("content") && !has("targetJob")) {
        throw fail(400, "Send at least one of title, content or targetJob", "VALIDATION");
    }
    const set = {};
    if (has("title")) {
        const title = cleanTitle(body.title);
        if (!title || title.length > 200) throw fail(400, "title must contain 1–200 characters", "VALIDATION", { field: "title" });
        set.title = title;
    }
    if (has("targetJob")) set.targetJob = cleanTargetJob(body.targetJob);

    const resume = await getResumeForOwner(user._id, resumeId, { select: "+source" });
    if (has("expectedRevision")) {
        const expected = Number(body.expectedRevision);
        if (!Number.isInteger(expected)) throw fail(400, "expectedRevision must be an integer", "VALIDATION", { field: "expectedRevision" });
        if (expected !== (resume.revision || 1)) throw revisionConflict(resume.revision || 1);
    }
    if ((resume.status || "active") !== "active") {
        throw fail(409, "This resume is archived. Restore it before editing.", "RESUME_ARCHIVED");
    }

    let contentChanged = false;
    if (has("content")) {
        if (typeof body.content !== "string") throw fail(400, "content must be text", "VALIDATION", { field: "content" });
        if (!isEditableKind(kindOf(resume))) {
            throw fail(409, "PDF and DOCX resumes can't be edited here. Upload a new version instead.", "NOT_EDITABLE");
        }
        if (resume.lockedAt) {
            throw fail(409, "This resume version was shared or submitted and is locked. Duplicate it to make changes.", "RESUME_LOCKED");
        }
        const source = body.content.replace(/\r\n?/g, "\n");
        if (!source.trim()) throw fail(400, "content can't be empty", "VALIDATION", { field: "content" });
        assertSourceSize(source);
        if (source !== resume.source) {
            const described = describeText(source, { kind: kindOf(resume) });
            Object.assign(set, {
                source,
                sourceBytes: Buffer.byteLength(source, "utf8"),
                extractedText: described.extractedText,
                sourceHash: described.sha256,
                meta: described.meta,
                ats: genericAts({ extractedText: described.extractedText, kind: kindOf(resume), meta: described.meta, sourceHash: described.sha256, user }),
            });
            contentChanged = true;
        }
    }

    if (!Object.keys(set).length) return serializeSummary(resume);
    const filter = { _id: resume._id, owner: user._id, revision: resume.revision || 1, status: "active" };
    if (contentChanged) filter.lockedAt = null;
    if (!resume.revision) delete filter.revision;
    const update = contentChanged ? { $set: set, $inc: { revision: 1 } } : { $set: set };
    const updated = await Resume.findOneAndUpdate(filter, update, { new: true, runValidators: true }).lean();
    if (!updated) {
        const fresh = await Resume.findOne({ _id: resume._id, owner: user._id }).lean();
        if (!fresh) throw notFound();
        if (fresh.lockedAt && contentChanged) {
            throw fail(409, "This resume version was shared or submitted and is locked. Duplicate it to make changes.", "RESUME_LOCKED");
        }
        if (fresh.status !== "active") throw fail(409, "This resume is archived. Restore it before editing.", "RESUME_ARCHIVED");
        throw revisionConflict(fresh.revision || 1);
    }
    await emitChanged(user._id, "updated", updated);
    return serializeSummary(updated);
};

/** DELETE /resumes/:id → {deleted, archived, primaryId}. Locked resumes are archived, others hard-deleted. */
export const deleteResume = async (ownerId, resumeId) => {
    const resume = await getResumeForOwner(ownerId, resumeId);
    if (resume.lockedAt) {
        let updated = resume;
        if (resume.status !== "archived" || resume.isPrimary) {
            updated = await Resume.findOneAndUpdate(
                { _id: resume._id },
                { $set: { status: "archived", archivedAt: resume.archivedAt || new Date(), isPrimary: false } },
                { new: true },
            ).lean();
        }
        const primaryId = await ensurePrimary(ownerId);
        await emitChanged(ownerId, "archived", updated);
        return { deleted: false, archived: true, primaryId };
    }
    await Resume.deleteOne({ _id: resume._id, owner: ownerId });
    await deleteStoredFile(resume.original);
    await deleteStoredFile(resume.pdf);
    const primaryId = await ensurePrimary(ownerId);
    await emitChanged(ownerId, "deleted", null, resume._id);
    return { deleted: true, archived: false, primaryId };
};

/** POST /resumes/:id/restore → ResumeSummary (status active). */
export const restoreResume = async (ownerId, resumeId) => {
    const resume = await getResumeForOwner(ownerId, resumeId);
    if (resume.status === "active") return serializeSummary(resume);
    await assertBelowLimit(ownerId);
    const updated = await Resume.findOneAndUpdate(
        { _id: resume._id, owner: ownerId },
        { $set: { status: "active" }, $unset: { archivedAt: 1 } },
        { new: true },
    ).lean();
    await ensurePrimary(ownerId);
    const fresh = await Resume.findById(updated._id).lean();
    await emitChanged(ownerId, "restored", fresh);
    return serializeSummary(fresh);
};

const copyStoredFile = async (ownerId, storedFile) => {
    const buffer = await storageFor(storedFile).get(storedFile);
    const extension = (String(storedFile.key).match(/\.([A-Za-z0-9]+)$/) || [])[1] || "bin";
    const file = await getStorage().put(`resumes/${ownerId}/${crypto.randomUUID()}.${extension}`, buffer, {
        contentType: storedFile.contentType,
        originalName: storedFile.originalName,
    });
    return { ...file, sha256: storedFile.sha256 || sha256Hex(buffer) };
};

/** POST /resumes/:id/duplicate → ResumeSummary (unlocked copy, not primary). */
export const duplicateResume = async (user, resumeId, { title } = {}) => {
    const base = await getResumeForOwner(user._id, resumeId, { select: "+source +extractedText" });
    await assertBelowLimit(user._id);
    const kind = kindOf(base);
    const newTitle = title !== undefined && title !== null && cleanTitle(title)
        ? cleanTitle(title)
        : `${base.title} (copy)`;
    if (newTitle.length > 200 && title) throw fail(400, "title must contain 1–200 characters", "VALIDATION", { field: "title" });
    const original = !isEditableKind(kind) && base.original ? await copyStoredFile(user._id, base.original) : undefined;
    try {
        const { resume } = await createResume({
            owner: user._id,
            kind,
            origin: "duplicated",
            title: newTitle.slice(0, 200),
            source: base.source,
            extractedText: base.extractedText,
            meta: base.meta,
            sourceHash: base.sourceHash,
            original,
            targetJob: base.targetJob ?? null,
            parent: base._id,
        }, { user, makePrimary: false });
        return serializeSummary(resume);
    } catch (error) {
        if (original) await deleteStoredFile(original);
        throw error;
    }
};

// ── apply patches ──────────────────────────────────────────────────────────

const validatePatchBody = (body) => {
    const patches = body?.patches;
    if (!Array.isArray(patches) || patches.length < 1 || patches.length > 50) {
        throw fail(400, "patches must be an array of 1–50 patches", "VALIDATION", { field: "patches" });
    }
    patches.forEach((patch, index) => {
        const valid = patch && typeof patch === "object"
            && typeof patch.originalSubstring === "string" && patch.originalSubstring.length > 0
            && typeof patch.replacementSubstring === "string"
            && (patch.charRange === undefined || (typeof patch.charRange === "object" && patch.charRange !== null));
        if (!valid) throw fail(400, `Patch ${index + 1} needs originalSubstring and replacementSubstring`, "VALIDATION", { field: `patches[${index}]` });
    });
    const mode = body.mode === undefined || body.mode === null || body.mode === "" ? "new-version" : String(body.mode);
    if (!["new-version", "in-place"].includes(mode)) throw fail(400, "mode must be new-version or in-place", "VALIDATION", { field: "mode" });
    return { patches, mode };
};

const tailoredTargetJob = (value) => {
    if (!value || typeof value !== "object") return null;
    const title = typeof value.title === "string" ? value.title.slice(0, 300) : "";
    const company = typeof value.company === "string" ? value.company.slice(0, 200) : "";
    return {
        source: value.source === "market" || value.source === "external" ? "market" : value.source === "campus" ? "campus" : null,
        id: value.id ? String(value.id).slice(0, 64) : null,
        title,
        company,
        roleTitle: title,
        companyName: company,
    };
};

/** POST /resumes/:id/apply-patches → {status, resume, applied, skipped}. */
export const applyPatches = async (user, resumeId, body = {}) => {
    const { patches, mode } = validatePatchBody(body);
    const base = await getResumeForOwner(user._id, resumeId, { select: "+source" });
    const kind = kindOf(base);
    if (!isEditableKind(kind)) {
        throw fail(409, "Suggestions for PDF/DOCX resumes can't be applied automatically", "NOT_EDITABLE");
    }
    if (mode === "in-place") {
        if (base.lockedAt) {
            throw fail(409, "This resume version was shared or submitted and is locked. Save the suggestions as a new version.", "RESUME_LOCKED");
        }
        if (base.status !== "active") throw fail(409, "This resume is archived. Restore it before editing.", "RESUME_ARCHIVED");
    }
    const source = base.source || "";
    const { accepted, skipped } = locatePatchesForApply(source, patches, { isLatex: kind === "latex" });
    if (!accepted.length) {
        throw fail(422, "None of the selected suggestions could be applied to the current resume", "NO_PATCHES_APPLIED", { skipped });
    }
    const newSource = applyLocatedPatches(source, accepted);
    assertSourceSize(newSource);
    const applied = accepted.map((patch) => patch.id);

    if (mode === "in-place") {
        const resume = await updateResume(user, base._id, { content: newSource, expectedRevision: base.revision || 1 });
        return { status: 200, resume, applied, skipped };
    }

    const targetJob = tailoredTargetJob(body.targetJob) ?? base.targetJob ?? null;
    const suffix = targetJob?.company || targetJob?.companyName || targetJob?.title || targetJob?.roleTitle || "";
    const requestedTitle = typeof body.title === "string" && cleanTitle(body.title) ? cleanTitle(body.title) : null;
    const title = (requestedTitle || (suffix ? `${base.title} – ${suffix}` : `${base.title} (tailored)`)).slice(0, 200);
    const described = describeText(newSource, { kind });
    const { resume } = await createResume({
        owner: user._id,
        kind,
        origin: "tailored",
        title,
        source: newSource,
        extractedText: described.extractedText,
        meta: described.meta,
        sourceHash: described.sha256,
        targetJob,
        parent: base._id,
    }, { user, makePrimary: body.makePrimary === true });
    return { status: 201, resume: serializeSummary(resume), applied, skipped };
};

// ── scoring ────────────────────────────────────────────────────────────────

/**
 * ScoreResult for an owned resume (default: primary, else newest active), optionally
 * against a job. Generic scores are written to `ats`; job-targeted ones never are.
 * @returns {Promise<object|null>} null when the student has no active resume
 */
export const scoreResumeById = async (user, resumeId = null, { jobId, jobSource, job: givenJob = null } = {}) => {
    const resume = resumeId
        ? await getResumeForOwner(user._id, resumeId, { select: "+extractedText" })
        : await getPrimaryResume(user._id, { select: "+extractedText" });
    if (!resume) return null;
    const job = givenJob || (jobId ? await resolveJob({ jobSource, jobId }, { user }) : null);
    return scoreResumeDoc(user, resume, job);
};

/** Score a loaded resume doc (with extractedText) against an optional JobRef. */
export const scoreResumeDoc = async (user, resume, job = null) => {
    const jobText = job ? (await resolveJobDescription({ user, job, save: false })).text : null;
    const result = scoreResume({
        text: resume.extractedText || "",
        kind: kindOf(resume),
        pages: resume.meta?.pages ?? null,
        profile: { skills: profileSkills(user) },
        job,
        jobText,
    });
    const computedAt = new Date();
    if (!job) {
        await Resume.updateOne(
            { _id: resume._id, sourceHash: resume.sourceHash },
            { $set: { ats: { score: result.score, grade: result.grade, sourceHash: resume.sourceHash, scorerVersion: SCORER_VERSION, computedAt } } },
            { timestamps: false },
        );
    }
    return {
        ...result,
        resume: { _id: String(resume._id), title: resume.title, kind: kindOf(resume), version: resume.version, isPrimary: Boolean(resume.isPrimary) },
        target: publicJob(job),
        computedAt: computedAt.toISOString(),
    };
};

/** POST /resume/score/preview — score text without storing anything. */
export const previewScore = async (user, { text, jobId, jobSource } = {}) => {
    if (typeof text !== "string" || !text.trim()) throw fail(400, "text is required", "VALIDATION", { field: "text" });
    assertSourceSize(text);
    const described = describeText(text);
    const job = jobId ? await resolveJob({ jobSource, jobId }, { user }) : null;
    const jobText = job ? (await resolveJobDescription({ user, job, save: false })).text : null;
    const result = scoreResume({
        text: described.extractedText,
        kind: described.kind,
        pages: null,
        profile: { skills: profileSkills(user) },
        job,
        jobText,
    });
    return { ...result, resume: null, target: publicJob(job), computedAt: new Date().toISOString() };
};

// ── compiled PDFs ──────────────────────────────────────────────────────────

const pdfIsFresh = (resume) => Boolean(resume.pdf?.key) && resume.pdf.sourceHash === resume.sourceHash;

/**
 * The resume's compiled PDF, compiling (and caching it in storage) when it is
 * missing or stale. `wantBuffer:false` skips downloading a fresh cached file.
 * @returns {Promise<{buffer: Buffer|null, stored: object|null, texErrors: number, ms: number, cached: boolean}>}
 */
export const getCompiledPdf = async (resumeInput, { userId, wantBuffer = true } = {}) => {
    let resume = resumeInput;
    if (kindOf(resume) !== "latex") throw fail(409, "Only LaTeX resumes are compiled to PDF", "NO_PDF");
    if (pdfIsFresh(resume)) {
        const texErrors = Number(resume.pdf.meta?.texErrors) || 0;
        if (!wantBuffer) return { buffer: null, stored: resume.pdf, texErrors, ms: 0, cached: true };
        try {
            const buffer = await storageFor(resume.pdf).get(resume.pdf);
            return { buffer, stored: resume.pdf, texErrors, ms: 0, cached: true };
        } catch (error) {
            console.warn(`[resume-lab] cached PDF ${resume.pdf.driver}:${resume.pdf.key} unreadable (${error?.message || error}); recompiling`);
        }
    }
    if (typeof resume.source !== "string") {
        resume = await Resume.findById(resume._id).select("+source").lean();
        if (!resume) throw notFound();
    }
    assertCompileAllowed(userId ?? resume.owner);
    const compiled = await compileLatex(resume.source, { userId: userId ?? resume.owner });
    let stored = null;
    try {
        const key = `resumes/${resume.owner}/${resume._id}-r${resume.revision || 1}-${String(resume.sourceHash).slice(0, 12)}.pdf`;
        const file = await getStorage().put(key, compiled.pdf, { contentType: "application/pdf", originalName: "resume.pdf" });
        const candidate = {
            ...file,
            sha256: sha256Hex(compiled.pdf),
            meta: { ...(file.meta || {}), texErrors: compiled.texErrors },
            sourceHash: resume.sourceHash,
            compiledAt: new Date(),
        };
        const result = await Resume.updateOne(
            { _id: resume._id, sourceHash: resume.sourceHash },
            { $set: { pdf: candidate } },
            { timestamps: false },
        );
        if (result.matchedCount) {
            stored = candidate;
            if (resume.pdf?.key && (resume.pdf.key !== candidate.key || resume.pdf.driver !== candidate.driver)) {
                await deleteStoredFile(resume.pdf);
            }
        } else {
            await deleteStoredFile(candidate);
        }
    } catch (error) {
        console.warn(`[resume-lab] compiled PDF not cached for ${resume._id}: ${error?.message || error}`);
    }
    return { buffer: compiled.pdf, stored, texErrors: compiled.texErrors, ms: compiled.ms, cached: false };
};

// ── generated resumes (Resume Bank) ────────────────────────────────────────

/** SIH `hashResume` — byte-identical dedupe key for generated resumes. */
export const generatedDedupeKey = (latexCode, targetJob) => crypto.createHash("sha256")
    .update(JSON.stringify({ latexCode: String(latexCode).trim(), targetJob: targetJob || null }))
    .digest("hex");

const PENDING_COMPILE_CODES = new Set(["COMPILER_UNAVAILABLE", "COMPILER_BUSY"]);

/**
 * POST /resume-bank/generated: compile with Tectonic, then save as a latex resume.
 * @returns {Promise<{resume: BankItem & {pdfStatus}, created: boolean}>}
 */
export const saveGeneratedResume = async ({ user, latexCode, title, targetJob }) => {
    if (typeof latexCode !== "string" || !latexCode.trim()) {
        throw fail(400, "latexCode is required", "VALIDATION", { field: "latexCode" });
    }
    const rawTrimmed = latexCode.trim();
    const source = rawTrimmed.replace(/\r\n?/g, "\n");
    assertSourceSize(source);
    const cleanedTarget = cleanTargetJob(targetJob);
    const dedupeKey = generatedDedupeKey(rawTrimmed, cleanedTarget);
    const withStatus = (resume) => ({ ...serializeBankItem(resume), pdfStatus: pdfIsFresh(resume) ? "ready" : "pending" });

    const existing = await Resume.findOne({ owner: user._id, dedupeKey }).lean();
    if (existing) return { resume: withStatus(existing), created: false };
    await assertBelowLimit(user._id);

    const described = describeText(source, { kind: "latex" });
    const _id = new mongoose.Types.ObjectId();
    let pdf;
    try {
        assertCompileAllowed(user._id);
        const compiled = await compileLatex(source, { userId: user._id });
        try {
            const key = `resumes/${user._id}/${_id}-r1-${described.sha256.slice(0, 12)}.pdf`;
            const file = await getStorage().put(key, compiled.pdf, { contentType: "application/pdf", originalName: "resume.pdf" });
            pdf = {
                ...file,
                sha256: sha256Hex(compiled.pdf),
                meta: { ...(file.meta || {}), texErrors: compiled.texErrors },
                sourceHash: described.sha256,
                compiledAt: new Date(),
            };
        } catch (error) {
            console.warn(`[resume-lab] generated resume PDF not stored: ${error?.message || error}`);
        }
    } catch (error) {
        const code = error?.errors?.[0]?.code;
        if (!PENDING_COMPILE_CODES.has(code)) throw error;
    }

    const resolvedTitle = cleanTitle(title)
        || cleanTitle(cleanedTarget?.roleTitle)
        || cleanTitle(cleanedTarget?.title)
        || "Generated Resume";
    try {
        const { resume, created } = await createResume({
            _id,
            owner: user._id,
            kind: "latex",
            origin: "generated",
            title: resolvedTitle,
            source,
            extractedText: described.extractedText,
            meta: described.meta,
            sourceHash: described.sha256,
            dedupeKey,
            pdf,
            targetJob: cleanedTarget,
        }, { user, makePrimary: false });
        if (!created && pdf) await deleteStoredFile(pdf);
        return { resume: withStatus(resume), created };
    } catch (error) {
        if (pdf) await deleteStoredFile(pdf);
        throw error;
    }
};

// ── cleanup ────────────────────────────────────────────────────────────────

/** Delete users' resumes, their stored files and their saved job descriptions (demo reset cascade). */
export const purgeResumesForUsers = async (userIds) => {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String).filter((id) => isObjectId(id));
    if (!ids.length) return { resumes: 0, overrides: 0 };
    const docs = await Resume.find({ owner: { $in: ids } }).select("original pdf").lean();
    const resumes = (await Resume.deleteMany({ owner: { $in: ids } })).deletedCount || 0;
    for (const doc of docs) {
        await deleteStoredFile(doc.original);
        await deleteStoredFile(doc.pdf);
    }
    const overrides = (await JobDescriptionOverride.deleteMany({ user: { $in: ids } })).deletedCount || 0;
    return { resumes, overrides };
};

export { emitChanged as emitResumeChanged, setPrimaryInternal };
// Signed-link helpers live in access.service.js (which imports this file); re-exported for callers.
export { buildPrivateResumeUrl, buildResumeAccessUrl } from "./access.service.js";
export { resolveJob, resolveJobDescription, resolveJobRef } from "./job-ref.service.js";
