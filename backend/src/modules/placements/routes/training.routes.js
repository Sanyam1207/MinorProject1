// /api/v1/training (docs/contracts/PLACEMENTS.md §6.4). /my comes before /:id.
import { Router } from "express";
import { asyncHandler, requireAuth, requireRole, send } from "../../../core/http.js";
import {
    cancelProgram,
    createProgram,
    deleteProgram,
    getProgram,
    listEnrollments,
    listMyEnrollments,
    listPrograms,
    markAttendance,
    registerForProgram,
    unregisterFromProgram,
    updateEnrollment,
    updateProgram,
} from "../services/training.service.js";
import { validateIdParam } from "./shared.js";

const router = Router();
router.use(requireAuth);
validateIdParam(router, "id", "programId");
validateIdParam(router, "enrollmentId");

router.get("/", asyncHandler(async (req, res) => send(res, await listPrograms(req.user, req.query), "Training programs loaded")));

router.get("/my", requireRole("student"), asyncHandler(async (req, res) => send(res, await listMyEnrollments(req.user), "Registrations loaded")));

router.post("/", requireRole("tpo"), asyncHandler(async (req, res) => send(res, await createProgram(req.user, req.body), "Program created", 201)));

router.get("/:id", asyncHandler(async (req, res) => send(res, await getProgram(req.user, req.params.id), "Program loaded")));

router.patch("/:id", requireRole("tpo"), asyncHandler(async (req, res) => send(res, await updateProgram(req.user, req.params.id, req.body), "Program updated")));

router.post("/:id/cancel", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await cancelProgram(req.user, req.params.id, req.body), "Program cancelled")
)));

router.delete("/:id", requireRole("tpo"), asyncHandler(async (req, res) => send(res, await deleteProgram(req.user, req.params.id), "Program deleted")));

router.post("/:id/register", requireRole("student"), asyncHandler(async (req, res) => {
    const { enrollment, created } = await registerForProgram(req.user, req.params.id);
    return send(res, { enrollment }, created ? "Registered" : "Registration re-activated", created ? 201 : 200);
}));

router.delete("/:id/register", requireRole("student"), asyncHandler(async (req, res) => (
    send(res, await unregisterFromProgram(req.user, req.params.id), "Registration cancelled")
)));

router.get("/:id/enrollments", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await listEnrollments(req.user, req.params.id), "Enrollments loaded")
)));

router.post("/:id/attendance", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await markAttendance(req.user, req.params.id, req.body), "Attendance saved")
)));

router.patch("/:id/enrollments/:enrollmentId", requireRole("tpo"), asyncHandler(async (req, res) => (
    send(res, await updateEnrollment(req.user, req.params.id, req.params.enrollmentId, req.body), "Enrollment updated")
)));

export default router;
