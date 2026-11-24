// /api/v1/applications (docs/contracts/PLACEMENTS.md §6.2). Literal routes come before /:id.
import { Router } from "express";
import { asyncHandler, requireAuth, requireRole, send } from "../../../core/http.js";
import {
    applicationResumeUrl,
    bulkChangeStatus,
    changeApplicationStatus,
    exportApplicationsCsv,
    getApplication,
    listApplications,
    listMyApplications,
    staffAddApplicant,
    withdrawApplication,
} from "../services/application.service.js";
import { sendCsv, validateIdParam } from "./shared.js";

const router = Router();
router.use(requireAuth);
validateIdParam(router, "id", "applicationId");

router.get("/my", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await listMyApplications(req.user, req.query), "Applications loaded")
)));

router.get("/export.csv", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    sendCsv(res, await exportApplicationsCsv(req.user, req.query))
)));

router.post("/bulk-status", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await bulkChangeStatus(req.user, req.body), "Applications updated")
)));

router.get("/", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await listApplications(req.user, req.query), "Applications loaded")
)));

router.post("/", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await staffAddApplicant(req.user, req.body), "Applicant added", 201)
)));

router.get("/:id", asyncHandler(async (req, res) => send(res, await getApplication(req.user, req.params.id), "Application loaded")));

router.patch("/:id/status", requireRole("tpo", "company"), asyncHandler(async (req, res) => (
    send(res, await changeApplicationStatus(req.user, req.params.id, req.body), "Application updated")
)));

router.post("/:id/withdraw", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await withdrawApplication(req.user, req.params.id, req.body), "Application withdrawn")
)));

router.get("/:id/resume", asyncHandler(async (req, res) => (
    send(res, await applicationResumeUrl(req.user, req.params.id), "Resume link created")
)));

export default router;
