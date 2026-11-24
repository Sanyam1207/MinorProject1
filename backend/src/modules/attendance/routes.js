// REST API mounted at /api/v1/attendance (ATTENDANCE.md "REST API").
import express from "express";
import { asyncHandler, fail, requireAuth, requireRole, send } from "../../core/http.js";
import {
    addStudents,
    archiveCourse,
    autoEnroll,
    courseReport,
    createCourse,
    getCourseDetail,
    joinCourse,
    listCourses,
    notifyDefaulters,
    regenerateJoinCode,
    removeStudent,
    updateCourse,
} from "./courses.service.js";
import { scan } from "./scan.service.js";
import { serializeCourse, serializeSession } from "./serializers.js";
import {
    autoScheduleSession,
    cancelSession,
    createSession,
    endSession,
    exportSessionCsv,
    generateForCourse,
    getSessionDetail,
    getSessionQr,
    listSessions,
    markRecord,
    mySchedule,
    refreshTimetable,
    startSession,
    updateSession,
} from "./sessions.service.js";
import { myHistory, mySummary } from "./student.service.js";

const router = express.Router();
router.use(requireAuth);

const ATTENDANCE_ROLES = ["teacher", "student", "tpo"]; // admin always passes requireRole
const anyRole = requireRole(...ATTENDANCE_ROLES);
const teacherOnly = requireRole("teacher");
const studentOnly = requireRole("student");
const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

// ── courses ────────────────────────────────────────────────────────────────
router.get("/courses", anyRole, asyncHandler(async (req, res) => {
    send(res, { courses: await listCourses(req.user, { status: req.query.status }) });
}));

router.post("/courses", teacherOnly, asyncHandler(async (req, res) => {
    const { course, added } = await createCourse(req.user, body(req));
    const timetable = course.timetable?.length ? await refreshTimetable(course.toObject()) : { removed: 0, created: 0 };
    send(res, { course: serializeCourse(course, { manage: true }), added, generated: timetable.created }, "Course created", 201);
}));

router.post("/courses/join", studentOnly, asyncHandler(async (req, res) => {
    const course = await joinCourse(req.user, body(req).joinCode);
    send(res, { course: serializeCourse(course, { manage: false }) }, `Joined ${course.code}`);
}));

router.get("/courses/:id", anyRole, asyncHandler(async (req, res) => {
    send(res, await getCourseDetail(req.user, req.params.id));
}));

router.patch("/courses/:id", teacherOnly, asyncHandler(async (req, res) => {
    const { course, timetableChanged } = await updateCourse(req.user, req.params.id, body(req));
    const timetable = timetableChanged ? await refreshTimetable(course.toObject()) : null;
    send(res, { course: serializeCourse(course, { manage: true }), ...(timetable ? { timetable } : {}) }, "Course updated");
}));

router.delete("/courses/:id", teacherOnly, asyncHandler(async (req, res) => {
    const course = await archiveCourse(req.user, req.params.id);
    send(res, { course: serializeCourse(course, { manage: true }) }, "Course archived");
}));

router.post("/courses/:id/students", teacherOnly, asyncHandler(async (req, res) => {
    send(res, await addStudents(req.user, req.params.id, body(req)));
}));

router.delete("/courses/:id/students/:studentId", teacherOnly, asyncHandler(async (req, res) => {
    send(res, await removeStudent(req.user, req.params.id, req.params.studentId));
}));

router.post("/courses/:id/auto-enroll", teacherOnly, asyncHandler(async (req, res) => {
    send(res, await autoEnroll(req.user, req.params.id));
}));

router.post("/courses/:id/join-code", teacherOnly, asyncHandler(async (req, res) => {
    send(res, await regenerateJoinCode(req.user, req.params.id));
}));

router.post("/courses/:id/generate", teacherOnly, asyncHandler(async (req, res) => {
    send(res, await generateForCourse(req.user, req.params.id, { days: body(req).days }));
}));

router.get("/courses/:id/report", anyRole, asyncHandler(async (req, res) => {
    send(res, await courseReport(req.user, req.params.id, { threshold: req.query.threshold }));
}));

router.post("/courses/:id/notify-defaulters", teacherOnly, asyncHandler(async (req, res) => {
    const { threshold, message } = body(req);
    send(res, await notifyDefaulters(req.user, req.params.id, { threshold, message }));
}));

// ── sessions ───────────────────────────────────────────────────────────────
router.get("/sessions", anyRole, asyncHandler(async (req, res) => {
    send(res, await listSessions(req.user, req.query));
}));

router.post("/sessions", teacherOnly, asyncHandler(async (req, res) => {
    const { session, course, notified } = await createSession(req.user, body(req));
    send(res, { session: serializeSession(session, { course, includeGeo: true }), notified }, "Class scheduled", 201);
}));

router.post("/sessions/auto", teacherOnly, asyncHandler(async (req, res) => {
    const { session, course, reason, notified } = await autoScheduleSession(req.user, body(req));
    send(res, { session: serializeSession(session, { course, includeGeo: true }), reason, notified }, "Class scheduled", 201);
}));

router.get("/sessions/:id", anyRole, asyncHandler(async (req, res) => {
    send(res, await getSessionDetail(req.user, req.params.id));
}));

router.patch("/sessions/:id", teacherOnly, asyncHandler(async (req, res) => {
    const { session, course, changed } = await updateSession(req.user, req.params.id, body(req));
    send(res, { session: serializeSession(session, { course, includeGeo: true }), changed }, changed ? "Class updated" : "Nothing to change");
}));

router.post("/sessions/:id/cancel", teacherOnly, asyncHandler(async (req, res) => {
    const { session, course } = await cancelSession(req.user, req.params.id, { reason: body(req).reason });
    send(res, { session: serializeSession(session, { course, includeGeo: true }) }, "Class cancelled");
}));

router.post("/sessions/:id/start", teacherOnly, asyncHandler(async (req, res) => {
    const { session, course, qr, alreadyLive } = await startSession(req.user, req.params.id, { geo: body(req).geo });
    send(res, { session: serializeSession(session, { course, includeGeo: true }), qr, alreadyLive }, alreadyLive ? "Class is already live" : "Attendance is open");
}));

router.post("/sessions/:id/end", teacherOnly, asyncHandler(async (req, res) => {
    const { session, course, alreadyEnded } = await endSession(req.user, req.params.id);
    const serialized = serializeSession(session, { course, includeGeo: true });
    send(res, { session: serialized, stats: serialized.stats, alreadyEnded }, "Class ended");
}));

router.get("/sessions/:id/qr", anyRole, asyncHandler(async (req, res) => {
    send(res, await getSessionQr(req.user, req.params.id));
}));

router.post("/sessions/:id/records", teacherOnly, asyncHandler(async (req, res) => {
    const { studentId, status, note } = body(req);
    const { record, stats } = await markRecord(req.user, req.params.id, { studentId, status, note });
    send(res, { record, stats }, "Attendance updated");
}));

router.get("/sessions/:id/export.csv", anyRole, asyncHandler(async (req, res) => {
    const { filename, csv } = await exportSessionCsv(req.user, req.params.id);
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(csv);
}));

// ── scanning + student views ───────────────────────────────────────────────
router.post("/scan", studentOnly, asyncHandler(async (req, res) => {
    const result = await scan(req.user, body(req));
    send(res, result, result.status === "late" ? "Marked late" : "Marked present");
}));

router.get("/me/summary", studentOnly, asyncHandler(async (req, res) => {
    send(res, await mySummary(req.user));
}));

router.get("/me/history", studentOnly, asyncHandler(async (req, res) => {
    send(res, await myHistory(req.user, { courseId: req.query.courseId, limit: req.query.limit }));
}));

router.get("/me/schedule", requireRole("student", "teacher"), asyncHandler(async (req, res) => {
    if (!["student", "teacher"].includes(req.user.role)) throw fail(403, "Only students and teachers have a class schedule", "FORBIDDEN");
    send(res, await mySchedule(req.user, { days: req.query.days }));
}));

export default router;
