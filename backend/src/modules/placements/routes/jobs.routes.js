// /api/v1/jobs and its alias /api/v1/drives (docs/contracts/PLACEMENTS.md §6.1). Literal routes come before /:id.
import { Router } from "express";
import { asyncHandler, requireAuth, requireRole, send } from "../../../core/http.js";
import {
    applyToDrive,
    exportApplicationsCsv,
    listApplications,
} from "../services/application.service.js";
import {
    closeDrive,
    createDrive,
    deleteDrive,
    driveEligibility,
    getDrive,
    listDrives,
    listMatchedDrives,
    publishDrive,
    rejectDrive,
    updateDrive,
} from "../services/drive.service.js";
import { sendCsv, validateIdParam } from "./shared.js";

const router = Router();
router.use(requireAuth);
validateIdParam(router, "id", "jobId");

router.get("/", asyncHandler(async (req, res) => send(res, await listDrives(req.user, req.query), "Drives loaded")));

router.get("/matched", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await listMatchedDrives(req.user, req.query), "Matched drives loaded")
)));

router.post("/", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await createDrive(req.user, req.body), "Drive created", 201)
)));

router.get("/:id", asyncHandler(async (req, res) => send(res, await getDrive(req.user, req.params.id), "Drive loaded")));

router.patch("/:id", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await updateDrive(req.user, req.params.id, req.body), "Drive updated")
)));

router.delete("/:id", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await deleteDrive(req.user, req.params.id), "Drive deleted")
)));

router.post("/:id/publish", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await publishDrive(req.user, req.params.id, req.body), "Drive published")
)));

router.post("/:id/reject", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await rejectDrive(req.user, req.params.id, req.body), "Drive rejected")
)));

router.post("/:id/close", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await closeDrive(req.user, req.params.id, req.body), "Drive closed")
)));

router.get("/:id/eligibility", requireRole("student", "tpo"), asyncHandler(async (req, res) => (
    send(res, await driveEligibility(req.user, req.params.id, { studentId: req.query.studentId }), "Eligibility checked")
)));

router.post("/:id/apply", requireRole("student"), asyncHandler(async (req, res) => {
    const { application, created } = await applyToDrive(req.user, req.params.id, {
        resumeId: req.body?.resumeId,
        coverNote: req.body?.coverNote,
        source: "web",
    });
    return send(res, { application }, created ? "Application submitted" : "Application re-activated", created ? 201 : 200);
}));

router.get("/:id/applications/export.csv", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    sendCsv(res, await exportApplicationsCsv(req.user, req.query, { jobId: req.params.id }))
)));

router.get("/:id/applications", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await listApplications(req.user, req.query, { jobId: req.params.id }), "Applicants loaded")
)));

export default router;
