// /api/v1/placements (docs/contracts/PLACEMENTS.md §6.5): caller context, stats and announcements.
import { Router } from "express";
import mongoose from "mongoose";
import { asyncHandler, requireAuth, requireRole, send } from "../../../core/http.js";
import { rateLimit } from "../../../core/rate-limit.js";
import { Company } from "../../../models/company.models.js";
import { academicYearFor } from "../services/academic-year.js";
import { sendAnnouncement } from "../services/announce.service.js";
import { computeStats } from "../services/stats.service.js";
import { idOf } from "../services/views.js";

const router = Router();
router.use(requireAuth);

const loadCollege = async (collegeId) => {
    if (!collegeId) return null;
    const College = mongoose.models.College;
    if (!College) return { _id: idOf(collegeId), name: "", domain: "" };
    const college = await College.findById(collegeId).select("name domain").lean();
    return college ? { _id: idOf(college._id), name: college.name || college.domain || "", domain: college.domain || "" } : null;
};

router.get("/me", asyncHandler(async (req, res) => {
    const user = req.user;
    const company = user.company ? await Company.findById(user.company).select("name").lean() : null;
    return send(res, {
        role: user.role,
        college: await loadCollege(user.college),
        company: company ? { _id: idOf(company._id), name: company.name } : null,
        academicYear: academicYearFor(),
    }, "Placement context loaded");
}));

router.get("/stats", requireRole("tpo"), asyncHandler(async (req, res) => send(res, await computeStats(req.user, req.query), "Placement stats loaded")));

router.post(
    "/announcements",
    requireRole("tpo"),
    rateLimit({ windowMs: 60_000, max: 5, keyFn: (req) => String(req.user?._id ?? "") }),
    asyncHandler(async (req, res) => send(res, await sendAnnouncement(req.user, req.body), "Announcement sent")),
);

export default router;
