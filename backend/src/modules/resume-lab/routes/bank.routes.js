// Resume Bank compatibility routes (/api/v1/resume-bank, RESUME-BYOK.md §8.2).
// Same paths and shapes as the SIH routes, backed by the unified Resume model.
import { Router } from "express";
import { asyncHandler, assertObjectId, fail, requireAuth, requireRole, send } from "../../../core/http.js";
import { AlumniConnection, MentorshipMessage } from "../../../models/alumni.models.js";
import { Resume } from "../models/resume.model.js";
import { buildResumeAccessUrl } from "../services/access.service.js";
import { listResumeMetadata, saveGeneratedResume } from "../services/resume.service.js";

const router = Router();
router.use(requireAuth);

router.get("/", requireRole("student"), asyncHandler(async (req, res) => {
    return send(res, await listResumeMetadata(req.user._id), "Resume bank loaded");
}));

router.post("/generated", requireRole("student"), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { resume, created } = await saveGeneratedResume({
        user: req.user,
        latexCode: body.latexCode,
        title: body.title,
        targetJob: body.targetJob || null,
    });
    return send(res, resume, created ? "Resume saved to bank" : "Resume already exists in bank", created ? 201 : 200);
}));

/** Owner, or an alumnus the resume was shared with (accepted or closed connection). */
export const canViewResume = async (user, resume) => {
    if (String(resume.owner) === String(user._id)) return true;
    if (user.role !== "alumni") return false;
    const shares = await MentorshipMessage.find({ type: "resume-share", resumeVersion: resume._id }).select("connection").lean();
    if (!shares.length) return false;
    return Boolean(await AlumniConnection.exists({
        _id: { $in: shares.map((message) => message.connection) },
        alumniUser: user._id,
        status: { $in: ["accepted", "closed"] },
    }));
};

router.get("/:id/access", asyncHandler(async (req, res) => {
    const id = assertObjectId(req.params.id, "id");
    const resume = await Resume.findById(id).select("+source").lean();
    if (!resume) throw fail(404, "Resume not found", "NOT_FOUND", { entity: "resume" });
    if (!await canViewResume(req.user, resume)) throw fail(403, "This resume has not been shared with you", "FORBIDDEN");
    const access = await buildResumeAccessUrl(resume, { viewerId: req.user._id, variant: req.query.variant });
    return send(res, access, "Temporary resume access created");
}));

export default router;
