// Resume catalog (/api/v1/resumes, RESUME-BYOK.md §8.3, §8.4).
// Static paths (/compile) come before /:id routes; /:id/file accepts either a
// signed query (no JWT) or the owner's JWT.
import { Router } from "express";
import { asyncHandler, assertObjectId, fail, requireAuth, requireRole, send } from "../../../core/http.js";
import { compileLatex } from "../latex/compiler.js";
import { Resume } from "../models/resume.model.js";
import { buildResumeAccessUrl, sendResumeFile, verifyResumeSignature } from "../services/access.service.js";
import { jobParams } from "../services/job-ref.service.js";
import {
    applyPatches,
    assertCompileAllowed,
    createFromContent,
    deleteResume,
    duplicateResume,
    getCompiledPdf,
    getResumeDetail,
    getResumeForOwner,
    listResumes,
    restoreResume,
    scoreResumeById,
    serializeSummary,
    setPrimary,
    updateResume,
} from "../services/resume.service.js";
import { createFromUpload, parseBool, pickUploadedFile, resumeUpload } from "../services/upload.service.js";
import { fileLimit, uploadLimit } from "./limits.js";

const router = Router();
const student = [requireAuth, requireRole("student")];

// ── POST /compile ───────────────────────────────────────────────────────────
router.post("/compile", ...student, asyncHandler(async (req, res) => {
    const body = req.body || {};
    let result;
    if (body.resumeId !== undefined && body.resumeId !== null && body.resumeId !== "") {
        const resume = await getResumeForOwner(req.user._id, assertObjectId(String(body.resumeId), "resumeId"), { select: "+source" });
        if ((resume.kind || "latex") !== "latex") throw fail(409, "Only LaTeX resumes can be compiled", "NO_PDF");
        const compiled = await getCompiledPdf(resume, { userId: req.user._id });
        result = { pdf: compiled.buffer, texErrors: compiled.texErrors, ms: compiled.ms };
    } else if (typeof body.latex === "string") {
        assertCompileAllowed(req.user._id);
        result = await compileLatex(body.latex, { userId: req.user._id });
    } else {
        throw fail(400, "Send {latex} or {resumeId}", "VALIDATION", { field: "latex" });
    }
    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"resume.pdf\"",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Latex-Errors": String(result.texErrors ?? 0),
        "X-Compile-Ms": String(Math.round(result.ms ?? 0)),
        "Access-Control-Expose-Headers": "X-Latex-Errors, X-Compile-Ms",
    });
    return res.send(result.pdf);
}));

// ── GET /:id/file (signed link or owner JWT) ─────────────────────────────────
const signedFile = asyncHandler(async (req, res, next) => {
    if (req.query.sig === undefined) return next();
    const id = assertObjectId(req.params.id, "id");
    const variant = String(req.query.variant ?? "");
    verifyResumeSignature({ resumeId: id, variant, exp: req.query.exp, viewer: req.query.viewer, sig: req.query.sig });
    const resume = await Resume.findById(id).select("+source").lean();
    if (!resume) throw fail(404, "Resume not found", "NOT_FOUND", { entity: "resume" });
    return sendResumeFile(res, resume, { variant, download: req.query.download === "1", userId: resume.owner });
});

const ownerFile = asyncHandler(async (req, res) => {
    const id = assertObjectId(req.params.id, "id");
    const resume = await getResumeForOwner(req.user._id, id, { select: "+source" });
    return sendResumeFile(res, resume, { variant: req.query.variant, download: req.query.download === "1", userId: req.user._id });
});

router.get("/:id/file", fileLimit, signedFile, requireAuth, ownerFile);

// ── everything else: student (admin passes) ────────────────────────────────
router.use(...student);

router.get("/", asyncHandler(async (req, res) => {
    const data = await listResumes(req.user._id, { status: req.query.status, kind: req.query.kind });
    return send(res, data, "Resumes loaded");
}));

router.post("/", uploadLimit, resumeUpload, asyncHandler(async (req, res) => {
    const body = req.body || {};
    let outcome;
    if (req.is("multipart/form-data")) {
        outcome = await createFromUpload(req.user, {
            file: pickUploadedFile(req),
            text: typeof body.text === "string" ? body.text : body.content,
            title: body.title,
            makePrimary: parseBool(body.makePrimary, true),
        });
    } else {
        outcome = await createFromContent(req.user, {
            title: body.title,
            kind: body.kind,
            content: body.content,
            makePrimary: parseBool(body.makePrimary, true),
            targetJob: body.targetJob,
        });
    }
    const status = outcome.created ? 201 : 200;
    return send(res, { resume: serializeSummary(outcome.resume), created: outcome.created },
        outcome.created ? "Resume created" : "This resume already exists", status);
}));

router.get("/:id", asyncHandler(async (req, res) => {
    const data = await getResumeDetail(req.user._id, assertObjectId(req.params.id, "id"));
    return send(res, data, "Resume loaded");
}));

const update = asyncHandler(async (req, res) => {
    const resume = await updateResume(req.user, assertObjectId(req.params.id, "id"), req.body || {});
    return send(res, { resume }, "Resume updated");
});
router.put("/:id", update);
router.patch("/:id", update);

router.delete("/:id", asyncHandler(async (req, res) => {
    const data = await deleteResume(req.user._id, assertObjectId(req.params.id, "id"));
    return send(res, data, data.deleted ? "Resume deleted" : "Resume archived (it was shared or submitted)");
}));

router.post("/:id/restore", asyncHandler(async (req, res) => {
    const resume = await restoreResume(req.user._id, assertObjectId(req.params.id, "id"));
    return send(res, { resume }, "Resume restored");
}));

router.post("/:id/primary", asyncHandler(async (req, res) => {
    const data = await setPrimary(req.user._id, assertObjectId(req.params.id, "id"));
    return send(res, data, "Primary resume updated");
}));

router.post("/:id/duplicate", uploadLimit, asyncHandler(async (req, res) => {
    const resume = await duplicateResume(req.user, assertObjectId(req.params.id, "id"), { title: req.body?.title });
    return send(res, { resume }, "Resume duplicated", 201);
}));

router.post("/:id/apply-patches", asyncHandler(async (req, res) => {
    const { status, ...data } = await applyPatches(req.user, assertObjectId(req.params.id, "id"), req.body || {});
    return send(res, data, status === 201 ? "Suggestions saved as a new version" : "Suggestions applied", status);
}));

router.get("/:id/score", asyncHandler(async (req, res) => {
    const id = assertObjectId(req.params.id, "id");
    const { jobId, jobSource } = jobParams(req.query);
    const result = await scoreResumeById(req.user, id, { jobId, jobSource });
    return send(res, result, "Resume scored");
}));

router.get("/:id/access", asyncHandler(async (req, res) => {
    const resume = await getResumeForOwner(req.user._id, assertObjectId(req.params.id, "id"), { select: "+source" });
    const access = await buildResumeAccessUrl(resume, { viewerId: req.user._id, variant: req.query.variant });
    return send(res, access, "Temporary resume access created");
}));

export default router;
