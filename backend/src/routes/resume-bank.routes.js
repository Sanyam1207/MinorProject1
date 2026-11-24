import { Router } from "express";
import mongoose from "mongoose";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import asynchandler from "../utils/asynchandler.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import { Resume } from "../models/resume.models.js";
import { AlumniConnection, MentorshipMessage } from "../models/alumni.models.js";
import { buildPrivateResumeUrl, listResumeMetadata, saveGeneratedResume } from "../services/resume-bank.service.js";

const router = Router();
router.use(verifyJWT);

const requireStudent = (req) => {
    if (req.user.role !== "student") throw new ApiError(403, "Student account required");
};

router.get("/", asynchandler(async (req, res) => {
    requireStudent(req);
    return res.json(new Apiresponse(200, await listResumeMetadata(req.user._id), "Resume bank loaded"));
}));

router.post("/generated", asynchandler(async (req, res) => {
    requireStudent(req);
    const result = await saveGeneratedResume({
        user: req.user,
        latexCode: req.body?.latexCode,
        title: req.body?.title,
        targetJob: req.body?.targetJob || null,
    });
    const { latexCode: _source, storage: _storage, sourceHash: _hash, ...safeResume } = result.resume;
    return res.status(result.created ? 201 : 200).json(new Apiresponse(result.created ? 201 : 200, safeResume, result.created ? "Resume saved to bank" : "Resume already exists in bank"));
}));

router.get("/:id/access", asynchandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, "Invalid resume ID");
    const resume = await Resume.findById(req.params.id).lean();
    if (!resume) throw new ApiError(404, "Resume not found");

    let allowed = String(resume.owner) === String(req.user._id);
    if (!allowed && req.user.role === "alumni") {
        const shareMessages = await MentorshipMessage.find({ type: "resume-share", resumeVersion: resume._id }).select("connection").lean();
        allowed = Boolean(await AlumniConnection.exists({
            _id: { $in: shareMessages.map((message) => message.connection) },
            alumniUser: req.user._id,
            status: { $in: ["accepted", "closed"] },
        }));
    }
    if (!allowed) throw new ApiError(403, "This resume has not been shared with you");

    const url = buildPrivateResumeUrl(resume);
    return res.json(new Apiresponse(200, { url, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }, "Temporary resume access created"));
}));

export default router;
