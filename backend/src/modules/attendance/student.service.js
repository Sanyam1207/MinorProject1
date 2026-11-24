// Student views: GET /me/summary and GET /me/history.
import mongoose from "mongoose";
import { fail, intParam, isObjectId } from "../../core/http.js";
import { DEFAULT_SETTINGS } from "./config.js";
import { AttendanceRecord, ClassSession, Course } from "./models/index.js";
import { idString, serializeCourse } from "./serializers.js";
import { attendanceStatus, computePercent, studentCourseSummaries } from "./stats.js";

const courseCard = (course) => {
    const full = serializeCourse(course, { manage: false });
    return {
        _id: full._id,
        code: full.code,
        name: full.name,
        section: full.section,
        teacher: full.teacher,
        status: full.status,
        minAttendancePercent: course.settings?.minAttendancePercent ?? DEFAULT_SETTINGS.minAttendancePercent,
    };
};

/** {courses:[{course, attended, late, absent, excused, held, percent, status, needToReach, canSkip}], overall}. */
export const mySummary = async (user) => {
    const courses = await Course.find({ students: user._id }).populate("teacher", "name email").lean();
    courses.sort((a, b) => (a.status === b.status ? a.code.localeCompare(b.code) : a.status === "active" ? -1 : 1));
    const summaries = await studentCourseSummaries(user._id, courses);
    const rows = courses.map((course) => ({ course: courseCard(course), ...summaries.get(String(course._id)) }));
    const totals = rows.reduce((sum, row) => ({
        attended: sum.attended + row.attended,
        held: sum.held + row.held,
        excused: sum.excused + row.excused,
    }), { attended: 0, held: 0, excused: 0 });
    // Overall status uses the strictest threshold among the student's active courses.
    const thresholds = courses.filter((course) => course.status === "active")
        .map((course) => course.settings?.minAttendancePercent ?? DEFAULT_SETTINGS.minAttendancePercent);
    const threshold = thresholds.length ? Math.max(...thresholds) : DEFAULT_SETTINGS.minAttendancePercent;
    const percent = computePercent(totals.attended, totals.held, totals.excused);
    return {
        courses: rows,
        overall: { ...totals, percent, status: attendanceStatus(percent, threshold), threshold },
    };
};

/** {records:[{_id, session:{_id, topic, startsAt, endsAt, status}, course:{_id, code, name}, status, method, markedAt, note}]}. */
export const myHistory = async (user, { courseId, limit } = {}) => {
    const max = intParam(limit, { min: 1, max: 200, fallback: 50 });
    const match = { student: new mongoose.Types.ObjectId(String(user._id)) };
    if (courseId !== undefined && courseId !== null && courseId !== "") {
        if (!isObjectId(String(courseId))) throw fail(400, "courseId must be a valid id", "VALIDATION", { field: "courseId" });
        match.course = new mongoose.Types.ObjectId(String(courseId));
    }
    const rows = await AttendanceRecord.aggregate([
        { $match: match },
        { $lookup: { from: ClassSession.collection.collectionName, localField: "session", foreignField: "_id", as: "classSession" } },
        { $unwind: "$classSession" },
        { $match: { "classSession.status": { $in: ["live", "ended"] } } },
        { $sort: { "classSession.startsAt": -1 } },
        { $limit: max },
        { $lookup: { from: Course.collection.collectionName, localField: "course", foreignField: "_id", as: "courseDoc" } },
        { $unwind: { path: "$courseDoc", preserveNullAndEmptyArrays: true } },
    ]);
    return {
        records: rows.map((row) => ({
            _id: idString(row._id),
            session: {
                _id: idString(row.classSession._id),
                topic: row.classSession.topic || "",
                startsAt: row.classSession.startsAt,
                endsAt: row.classSession.endsAt,
                status: row.classSession.status,
            },
            course: row.courseDoc ? { _id: idString(row.courseDoc._id), code: row.courseDoc.code, name: row.courseDoc.name } : { _id: idString(row.course) },
            status: row.status,
            method: row.method,
            markedAt: row.markedAt,
            note: row.note ?? null,
        })),
    };
};
