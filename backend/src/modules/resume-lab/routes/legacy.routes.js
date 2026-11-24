// Legacy SIH routes (/api/v1/resume, RESUME-BYOK.md §8.1): upload + ATS score.
import { Router } from "express";
import { asyncHandler, assertObjectId, requireAuth, requireRole, send } from "../../../core/http.js";
import { Resume } from "../models/resume.model.js";
import { jobParams, resolveJob } from "../services/job-ref.service.js";
import { previewScore, scoreResumeById, scoreResumeDoc } from "../services/resume.service.js";
import { createFromUpload, parseBool, pickUploadedFile, resumeUpload } from "../services/upload.service.js";
import { uploadLimit } from "./limits.js";

const router = Router();
router.use(requireAuth, requireRole("student"));

router.post("/upload", uploadLimit, resumeUpload, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { jobId, jobSource } = jobParams(body);
    // Resolve the score target first so a bad job never creates a resume.
    const job = jobId ? await resolveJob({ jobSource, jobId }, { user: req.user }) : null;
    const { resume, created } = await createFromUpload(req.user, {
        file: pickUploadedFile(req),
        text: body.text,
        title: body.title,
        makePrimary: parseBool(body.makePrimary, true),
    });
    const stored = await Resume.findById(resume._id).select("+extractedText").lean();
    const result = await scoreResumeDoc(req.user, stored, job);
    return send(res, { ...result, created }, created ? "Resume uploaded and scored" : "This resume was already uploaded", created ? 201 : 200);
}));

router.get("/score", asyncHandler(async (req, res) => {
    const resumeId = req.query.resumeId ? assertObjectId(String(req.query.resumeId), "resumeId") : null;
    const { jobId, jobSource } = jobParams(req.query);
    const result = await scoreResumeById(req.user, resumeId, { jobId, jobSource });
    return send(res, result ?? null, result ? "Resume scored" : "No resume uploaded yet");
}));

router.post("/score/preview", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { jobId, jobSource } = jobParams(body);
    const result = await previewScore(req.user, { text: body.text, jobId, jobSource });
    return send(res, result, "Preview score (not saved)");
}));

export default router;
