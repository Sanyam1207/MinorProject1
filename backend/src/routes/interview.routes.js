import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
import { assertObjectId, fail } from "../core/http.js";
import { getInterviewById, listStudentInterviews } from "../services/interview.service.js";

const router = Router();
router.use(verifyJWT);

router.get("/", asynchandler(async (req, res) => {
    if (req.user.role !== "student") throw new ApiError(403, "Student account required");
    const interviews = await listStudentInterviews(req.user._id, req.query.limit);
    return res.json(new Apiresponse(200, interviews, "Interview results loaded"));
}));

// LearningRecommendationWorkspace.jsx reads `res.data` as an array (PLACEMENTS.md §6.6).
router.get("/my", asynchandler(async (req, res) => {
    if (req.user.role !== "student") throw fail(403, "Student account required", "FORBIDDEN");
    const interviews = await listStudentInterviews(req.user._id, req.query.limit, { includeRaw: true });
    return res.json(new Apiresponse(200, interviews, "Interview results loaded"));
}));

// Owner only: another user's interview answers 404, so ids do not leak.
router.get("/:id", asynchandler(async (req, res) => {
    const interviewId = assertObjectId(req.params.id, "interviewId");
    const interview = await getInterviewById(req.user._id, interviewId);
    if (!interview) throw fail(404, "Interview not found", "NOT_FOUND");
    return res.json(new Apiresponse(200, { ...interview, interviewId: interview._id.toString() }, "Interview loaded"));
}));

export default router;
