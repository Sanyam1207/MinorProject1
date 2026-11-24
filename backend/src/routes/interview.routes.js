import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
import { listStudentInterviews } from "../services/interview.service.js";

const router = Router();
router.use(verifyJWT);

router.get("/", asynchandler(async (req, res) => {
    if (req.user.role !== "student") throw new ApiError(403, "Student account required");
    const interviews = await listStudentInterviews(req.user._id, req.query.limit);
    return res.json(new Apiresponse(200, interviews, "Interview results loaded"));
}));

export default router;

