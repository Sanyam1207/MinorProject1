// Loading + role/ownership checks shared by routes, sockets and tools.
//   owner     the course's teacher (manages the course and its sessions)
//   oversight tpo / admin (read-only access to every course, session and report)
//   enrolled  a student in course.students
import mongoose from "mongoose";
import { fail, isObjectId } from "../../core/http.js";
import { ClassSession, Course } from "./models/index.js";
import { sameId } from "./serializers.js";

export const isOversight = (user) => user?.role === "tpo" || user?.role === "admin";
export const isOwner = (user, course) => Boolean(user && course) && sameId(course.teacher, user._id);
export const isEnrolled = (user, course) => Boolean(user && course)
    && (course.students || []).some((student) => sameId(student, user._id));

export const assertId = (value, field = "id") => {
    if (!isObjectId(typeof value === "string" ? value.trim() : value)) {
        throw fail(400, `${field} must be a valid id`, "VALIDATION", { field });
    }
    return new mongoose.Types.ObjectId(String(value).trim());
};

export const loadCourse = async (courseId, { lean = false } = {}) => {
    const id = assertId(courseId, "courseId");
    const query = Course.findById(id);
    const course = lean ? await query.lean() : await query;
    if (!course) throw fail(404, "Course not found", "NOT_FOUND");
    return course;
};

export const assertCanManageCourse = (user, course) => {
    if (!isOwner(user, course)) throw fail(403, "Only the course's teacher can do this", "FORBIDDEN");
};

export const assertCanViewCourse = (user, course) => {
    if (isOwner(user, course) || isOversight(user) || (user?.role === "student" && isEnrolled(user, course))) return;
    throw fail(403, "You don't have access to this course", "FORBIDDEN");
};

export const assertCanReportCourse = (user, course) => {
    if (isOwner(user, course) || isOversight(user)) return;
    throw fail(403, "Only the course's teacher or the placement office can see this report", "FORBIDDEN");
};

/** Session + its course (both mongoose docs unless lean). */
export const loadSession = async (sessionId, { lean = false, withNonce = false } = {}) => {
    const id = assertId(sessionId, "sessionId");
    let query = ClassSession.findById(id);
    if (withNonce) query = query.select("+qr.nonce");
    const session = lean ? await query.lean() : await query;
    if (!session) throw fail(404, "Class session not found", "NOT_FOUND");
    const course = lean ? await Course.findById(session.course).lean() : await Course.findById(session.course);
    if (!course) throw fail(404, "The course of this session no longer exists", "NOT_FOUND");
    return { session, course };
};

export const assertCanManageSession = (user, session, course) => {
    if (sameId(session.teacher, user?._id) || isOwner(user, course)) return;
    throw fail(403, "Only the class's teacher can do this", "FORBIDDEN");
};

export const assertCanReportSession = (user, session, course) => {
    if (sameId(session.teacher, user?._id) || isOwner(user, course) || isOversight(user)) return;
    throw fail(403, "Only the class's teacher or the placement office can see this", "FORBIDDEN");
};
