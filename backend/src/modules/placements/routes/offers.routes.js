// /api/v1/offers including /offers/policy (docs/contracts/PLACEMENTS.md §6.3). /my and /policy come before /:id.
import { Router } from "express";
import { asyncHandler, fail, requireAuth, requireRole, send } from "../../../core/http.js";
import { User } from "../../../models/user.models.js";
import { academicYearFor, isValidAcademicYear } from "../services/academic-year.js";
import {
    acceptOffer,
    createOffer,
    getOffer,
    listMyOffers,
    listOffers,
    overrideOffer,
    placeOffer,
    rejectOffer,
    revokeOffer,
    updateOffer,
    withdrawOffer,
} from "../services/offer.service.js";
import { resolvePolicy, savePolicy } from "../services/policy.service.js";
import { toPolicyView } from "../services/views.js";
import { validateIdParam } from "./shared.js";

const router = Router();
router.use(requireAuth);
validateIdParam(router, "id", "offerId");

const withUpdater = async (policy) => {
    if (!policy?.updatedBy) return toPolicyView(policy);
    const updater = await User.findById(policy.updatedBy).select("name").lean();
    return toPolicyView({ ...policy, updatedBy: updater ? { _id: updater._id, name: updater.name } : policy.updatedBy });
};

router.get("/my", requireRole("student"), asyncHandler(async (req, res) => send(res, await listMyOffers(req.user), "Offers loaded")));

router.get("/policy", asyncHandler(async (req, res) => {
    const requested = req.query.academicYear;
    if (requested !== undefined && requested !== "" && !isValidAcademicYear(String(requested))) {
        throw fail(400, "academicYear must look like 2026-27", "VALIDATION", { field: "academicYear" });
    }
    const college = req.user.role === "admin" && req.query.collegeId ? req.query.collegeId : req.user.college;
    const policy = await resolvePolicy(college ?? null, requested ? String(requested) : academicYearFor());
    return send(res, await withUpdater(policy), "Policy loaded");
}));

const savePolicyHandler = asyncHandler(async (req, res) => send(res, await withUpdater(await savePolicy(req.user, req.body)), "Policy saved"));
router.post("/policy", requireRole("tpo"), savePolicyHandler);
router.put("/policy", requireRole("tpo"), savePolicyHandler);

router.get("/", requireRole("tpo", "company"), asyncHandler(async (req, res) => send(res, await listOffers(req.user, req.query), "Offers loaded")));

router.post("/", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await createOffer(req.user, req.body), "Offer extended", 201)
)));

router.get("/:id", asyncHandler(async (req, res) => send(res, await getOffer(req.user, req.params.id), "Offer loaded")));

router.patch("/:id", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await updateOffer(req.user, req.params.id, req.body), "Offer updated")
)));

router.post("/:id/accept", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await acceptOffer(req.user, req.params.id), "Offer accepted")
)));

router.post("/:id/reject", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await rejectOffer(req.user, req.params.id, req.body), "Offer declined")
)));

router.post("/:id/withdraw", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await withdrawOffer(req.user, req.params.id, req.body), "Offer withdrawn")
)));

router.post("/:id/place", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await placeOffer(req.user, req.params.id), "Placement confirmed")
)));

router.post("/:id/override", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await overrideOffer(req.user, req.params.id, req.body), "Offer overridden")
)));

router.post("/:id/revoke", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await revokeOffer(req.user, req.params.id, req.body), "Offer revoked")
)));

export default router;
