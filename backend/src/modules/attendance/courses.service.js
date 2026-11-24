// Courses: CRUD, enrolment (join code, teacher list, auto-enrol), reports and
// defaulter notices (ATTENDANCE.md "REST API → Courses").
import crypto from "node:crypto";
import mongoose from "mongoose";
import { escapeRegex, fail, isObjectId } from "../../core/http.js";
import { User } from "../../models/user.models.js";
import {
    assertCanManageCourse,
    assertCanReportCourse,
    assertCanViewCourse,
    isOversight,
    isOwner,
    loadCourse,
} from "./access.js";
import {
    DEFAULT_SETTINGS,
    JOIN_CODE_ALPHABET,
    JOIN_CODE_RE,
    MAX_DURATION_MINUTES,
    MIN_DURATION_MINUTES,
    SETTINGS_BOUNDS,
    parseHHmm,
    parseWeekday,
} from "./config.js";
import { ClassSession, Course } from "./models/index.js";
import { notifyLowAttendance } from "./notifications.js";
import { idString, serializeCourse, serializeSession, userCard } from "./serializers.js";
import { courseStudentSummaries, heldByCourse, studentCourseSummaries } from "./stats.js";
import { formatDate } from "./time.js";

const STUDENT_CARD_FIELDS = "name email ggsipuEnrollment rollNumber branch section passingYear semester";

const validation = (message, field) => fail(400, message, "VALIDATION", field ? { field } : {});

// ── input normalisation ────────────────────────────────────────────────────

const optionalText = (body, key, max, out) => {
    if (!(key in body)) return;
    const value = body[key];
    if (value === null || value === undefined || String(value).trim() === "") {
        out[key] = undefined;
        return;
    }
    if (typeof value !== "string" && typeof value !== "number") throw validation(`${key} must be text`, key);
    const text = String(value).trim();
    if (text.length > max) throw validation(`${key} must be at most ${max} characters`, key);
    out[key] = text;
};

export const normaliseTimetable = (value) => {
    if (value === null || value === undefined || value === "") return [];
    if (!Array.isArray(value)) throw validation("timetable must be a list of weekly slots", "timetable");
    if (value.length > 50) throw validation("A timetable can have at most 50 weekly slots", "timetable");
    return value.map((slot, index) => {
        if (!slot || typeof slot !== "object") throw validation(`timetable[${index}] must be an object`, "timetable");
        const day = parseWeekday(slot.day);
        if (day === null) throw validation(`timetable[${index}].day must be 0-6 (0 = Sunday) or a weekday name`, "timetable");
        const start = parseHHmm(slot.start);
        if (!start) throw validation(`timetable[${index}].start must be "HH:mm"`, "timetable");
        const duration = slot.durationMinutes === undefined || slot.durationMinutes === null || slot.durationMinutes === ""
            ? 60
            : Number(slot.durationMinutes);
        if (!Number.isInteger(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
            throw validation(`timetable[${index}].durationMinutes must be a whole number between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}`, "timetable");
        }
        const room = slot.room === undefined || slot.room === null ? undefined : String(slot.room).trim().slice(0, 60) || undefined;
        return { day, start: start.text, durationMinutes: duration, ...(room ? { room } : {}) };
    });
};

export const normaliseSettings = (value, base = DEFAULT_SETTINGS) => {
    const settings = { ...DEFAULT_SETTINGS, ...(base || {}) };
    if (value === null || value === undefined) return settings;
    if (typeof value !== "object" || Array.isArray(value)) throw validation("settings must be an object", "settings");
    for (const [key, [min, max]] of Object.entries(SETTINGS_BOUNDS)) {
        if (!(key in value) || value[key] === null || value[key] === undefined || value[key] === "") continue;
        const number = Number(value[key]);
        if (!Number.isFinite(number) || number < min || number > max) {
            throw validation(`settings.${key} must be between ${min} and ${max}`, `settings.${key}`);
        }
        settings[key] = key === "minAttendancePercent" ? Math.round(number * 10) / 10 : Math.round(number);
    }
    if ("requireGeo" in value && value.requireGeo !== null && value.requireGeo !== undefined) {
        const flag = value.requireGeo;
        if (typeof flag === "boolean") settings.requireGeo = flag;
        else if (["true", "false"].includes(String(flag).toLowerCase())) settings.requireGeo = String(flag).toLowerCase() === "true";
        else throw validation("settings.requireGeo must be true or false", "settings.requireGeo");
    }
    return settings;
};

/** Validated course fields from a create (partial=false) or update (partial=true) body. */
export const normaliseCourseInput = (body = {}, { partial = false, current = null } = {}) => {
    if (!body || typeof body !== "object") throw validation("Send the course as a JSON object");
    const out = {};
    if (!partial || "code" in body) {
        const code = String(body.code ?? "").trim().toUpperCase();
        if (!code) throw validation("code is required, e.g. CS301", "code");
        if (!/^[A-Z0-9][A-Z0-9 _./-]{0,19}$/.test(code)) throw validation("code must be up to 20 letters, digits, spaces or - _ . /", "code");
        out.code = code;
    }
    if (!partial || "name" in body) {
        const name = String(body.name ?? "").trim();
        if (!name) throw validation("name is required", "name");
        if (name.length > 160) throw validation("name must be at most 160 characters", "name");
        out.name = name;
    }
    optionalText(body, "department", 80, out);
    optionalText(body, "branch", 80, out);
    optionalText(body, "section", 10, out);
    optionalText(body, "passingYear", 10, out);
    optionalText(body, "academicYear", 20, out);
    optionalText(body, "room", 60, out);
    if (typeof out.section === "string") out.section = out.section.toUpperCase();
    if ("semester" in body) {
        if (body.semester === null || body.semester === undefined || body.semester === "") out.semester = undefined;
        else {
            const semester = Number(body.semester);
            if (!Number.isInteger(semester) || semester < 1 || semester > 12) throw validation("semester must be 1-12", "semester");
            out.semester = semester;
        }
    }
    if ("timetable" in body) out.timetable = normaliseTimetable(body.timetable);
    if (!partial || "settings" in body) out.settings = normaliseSettings(body.settings, current?.settings ? plainSettings(current.settings) : DEFAULT_SETTINGS);
    return out;
};

const plainSettings = (settings) => (typeof settings?.toObject === "function" ? settings.toObject() : { ...settings });

// ── join codes ─────────────────────────────────────────────────────────────

export const generateJoinCode = () => {
    let code = "";
    for (let i = 0; i < 6; i += 1) code += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)];
    return code;
};

const isJoinCodeClash = (error) => error?.code === 11000 && Object.keys(error.keyPattern || error.keyValue || {}).includes("joinCode");
const isCourseClash = (error) => error?.code === 11000 && Object.keys(error.keyPattern || error.keyValue || {}).includes("teacher");

const duplicateCourse = (fields) => fail(
    409,
    `You already have an active course ${fields.code}${fields.section ? ` (section ${fields.section})` : ""}${fields.academicYear ? ` for ${fields.academicYear}` : ""}`,
    "DUPLICATE",
);

/** Run `write(joinCode)` until it does not collide with another course's join code. */
const withFreshJoinCode = async (write) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            return await write(generateJoinCode());
        } catch (error) {
            if (!isJoinCodeClash(error)) throw error;
        }
    }
    throw fail(503, "Could not allocate a join code, please retry", "ERROR");
};

// ── enrolment ──────────────────────────────────────────────────────────────

/** Students matching the course's branch (+ section, passing year, semester when set). */
export const findAutoEnrollStudents = async (course) => {
    const branch = course.branch || course.department;
    if (!branch) throw validation("Set the course's branch before auto-enrolling students", "branch");
    const filter = {
        role: "student",
        isActive: { $ne: false },
        branch: new RegExp(`^\\s*${escapeRegex(branch.trim())}\\s*$`, "i"),
    };
    if (course.section) filter.section = new RegExp(`^${escapeRegex(course.section)}$`, "i");
    if (course.passingYear) filter.passingYear = String(course.passingYear).trim();
    // Semester changes every term and is often unrecorded: students without one still match.
    if (course.semester) filter.semester = { $in: [course.semester, null] };
    return User.find(filter).select("_id").lean();
};

const addToCourse = async (courseId, userIds) => {
    if (!userIds.length) return 0;
    const before = await Course.findById(courseId).select("students").lean();
    const existing = new Set((before?.students || []).map(String));
    const fresh = [...new Set(userIds.map(String))].filter((id) => !existing.has(id));
    if (!fresh.length) return 0;
    await Course.updateOne({ _id: courseId }, { $addToSet: { students: { $each: fresh.map((id) => new mongoose.Types.ObjectId(id)) } } });
    return fresh.length;
};

export const autoEnroll = async (user, courseId) => {
    const course = await loadCourse(courseId);
    assertCanManageCourse(user, course);
    const matches = await findAutoEnrollStudents(course);
    const added = await addToCourse(course._id, matches.map((student) => student._id));
    return { added, matched: matches.length };
};

export const addStudents = async (user, courseId, { emails, userIds } = {}) => {
    const course = await loadCourse(courseId);
    assertCanManageCourse(user, course);
    const emailList = (Array.isArray(emails) ? emails : typeof emails === "string" ? emails.split(/[\s,;]+/) : [])
        .map((email) => String(email).trim().toLowerCase())
        .filter(Boolean);
    const idList = (Array.isArray(userIds) ? userIds : userIds ? [userIds] : []).map((id) => String(id).trim()).filter(Boolean);
    if (!emailList.length && !idList.length) throw validation("Send emails or userIds to add", "emails");
    if (emailList.length + idList.length > 1000) throw validation("Add at most 1000 students at a time", "emails");
    const invalidIds = idList.filter((id) => !isObjectId(id));
    const uniqueEmails = [...new Set(emailList)];

    const [byEmail, byId] = await Promise.all([
        uniqueEmails.length ? User.find({ email: { $in: uniqueEmails } }).select("_id email role").lean() : [],
        idList.length - invalidIds.length ? User.find({ _id: { $in: idList.filter(isObjectId) } }).select("_id email role").lean() : [],
    ]);
    const students = [...byEmail, ...byId].filter((candidate) => candidate.role === "student");
    const found = new Set(byEmail.filter((candidate) => candidate.role === "student").map((candidate) => candidate.email));
    const notFound = uniqueEmails.filter((email) => !found.has(email));
    const studentIds = new Set(byId.filter((candidate) => candidate.role === "student").map((candidate) => String(candidate._id)));
    const unknownIds = [...invalidIds, ...idList.filter((id) => isObjectId(id) && !studentIds.has(id))];
    const added = await addToCourse(course._id, students.map((student) => student._id));
    return { added, notFound, ...(unknownIds.length ? { unknownIds: [...new Set(unknownIds)] } : {}) };
};

export const removeStudent = async (user, courseId, studentId) => {
    const course = await loadCourse(courseId);
    assertCanManageCourse(user, course);
    if (!isObjectId(studentId)) throw validation("studentId must be a valid id", "studentId");
    const result = await Course.updateOne({ _id: course._id }, { $pull: { students: new mongoose.Types.ObjectId(studentId) } });
    return { removed: result.modifiedCount > 0 };
};

export const joinCourse = async (user, joinCode) => {
    const code = String(joinCode ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
    if (!JOIN_CODE_RE.test(code)) throw fail(404, "No course has this join code", "NOT_FOUND");
    const course = await Course.findOneAndUpdate(
        { joinCode: code, status: "active" },
        { $addToSet: { students: user._id } },
        { returnDocument: "after" },
    ).populate("teacher", "name email");
    if (!course) throw fail(404, "No course has this join code", "NOT_FOUND");
    return course;
};

export const regenerateJoinCode = async (user, courseId) => {
    const course = await loadCourse(courseId);
    assertCanManageCourse(user, course);
    const updated = await withFreshJoinCode((joinCode) => Course.findOneAndUpdate(
        { _id: course._id },
        { $set: { joinCode } },
        { returnDocument: "after", runValidators: true },
    ));
    return { joinCode: updated.joinCode };
};

// ── create / update / archive ──────────────────────────────────────────────

export const createCourse = async (user, body = {}) => {
    const fields = normaliseCourseInput(body);
    if (!fields.department && user.department) fields.department = user.department;
    const autoEnrollRequested = body.autoEnroll === true || String(body.autoEnroll).toLowerCase() === "true";
    if (autoEnrollRequested && !fields.branch && !fields.department) {
        throw validation("Set the course's branch to auto-enroll students", "branch");
    }
    let course;
    try {
        course = await withFreshJoinCode((joinCode) => Course.create({ ...fields, teacher: user._id, joinCode, students: [] }));
    } catch (error) {
        if (isCourseClash(error)) throw duplicateCourse(fields);
        throw error;
    }
    let added = 0;
    if (autoEnrollRequested) {
        const matches = await findAutoEnrollStudents(course);
        added = await addToCourse(course._id, matches.map((student) => student._id));
        if (added) course = await Course.findById(course._id);
    }
    return { course, added };
};

export const updateCourse = async (user, courseId, body = {}) => {
    const course = await loadCourse(courseId);
    assertCanManageCourse(user, course);
    if (course.status !== "active") throw fail(409, "Archived courses can't be edited", "INVALID_STATE");
    const fields = normaliseCourseInput(body, { partial: true, current: course });
    const set = {};
    const unset = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) unset[key] = "";
        else set[key] = value;
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) return { course, timetableChanged: false };
    let updated;
    try {
        updated = await Course.findOneAndUpdate(
            { _id: course._id },
            { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
            { returnDocument: "after", runValidators: true },
        );
    } catch (error) {
        if (isCourseClash(error)) throw duplicateCourse({ ...course.toObject(), ...set });
        throw error;
    }
    return { course: updated, timetableChanged: "timetable" in fields };
};

export const archiveCourse = async (user, courseId, { now = new Date() } = {}) => {
    const course = await loadCourse(courseId);
    assertCanManageCourse(user, course);
    const archived = await Course.findOneAndUpdate({ _id: course._id }, { $set: { status: "archived" } }, { returnDocument: "after" });
    // Classes that were never held are called off silently.
    await ClassSession.updateMany(
        { course: course._id, status: "scheduled", startsAt: { $gt: now } },
        { $set: { status: "cancelled", cancelReason: "Course archived", cancelledAt: now } },
    );
    return archived;
};

// ── reads ──────────────────────────────────────────────────────────────────

const statusFilter = (status) => {
    const value = String(status ?? "").trim().toLowerCase();
    // "archived" / "all" include archived courses (active ones first); default: active only.
    if (value === "archived" || value === "all") return { $in: ["active", "archived"] };
    return "active";
};

/** Next scheduled/live session per course id. */
const nextSessions = async (courseIds, now) => {
    if (!courseIds.length) return new Map();
    const rows = await ClassSession.aggregate([
        { $match: { course: { $in: courseIds }, status: { $in: ["scheduled", "live"] }, endsAt: { $gt: now } } },
        { $sort: { startsAt: 1 } },
        { $group: { _id: "$course", session: { $first: "$$ROOT" } } },
    ]);
    return new Map(rows.map((row) => [String(row._id), row.session]));
};

const sortCourses = (a, b) => (a.status === b.status ? a.code.localeCompare(b.code) : a.status === "active" ? -1 : 1);

export const listCourses = async (user, { status, now = new Date() } = {}) => {
    const filter = { status: statusFilter(status) };
    if (user.role === "teacher") filter.teacher = user._id;
    else if (user.role === "student") filter.students = user._id;
    else if (!isOversight(user)) throw fail(403, "Attendance is available to teachers, students and the placement office", "FORBIDDEN");
    const courses = await Course.find(filter).populate("teacher", "name email").sort({ code: 1 }).lean();
    const ids = courses.map((course) => course._id);
    const next = await nextSessions(ids, now);
    let summaries = new Map();
    if (user.role === "student") summaries = await studentCourseSummaries(user._id, courses);
    return courses.sort(sortCourses).map((course) => {
        const manage = isOwner(user, course) || isOversight(user);
        const out = serializeCourse(course, { manage });
        const upcoming = next.get(String(course._id));
        out.nextSession = upcoming ? serializeSession(upcoming, { now, course }) : null;
        if (user.role === "student") {
            const summary = summaries.get(String(course._id));
            out.summary = { attended: summary.attended, held: summary.held, percent: summary.percent, status: summary.status };
        }
        return out;
    });
};

const upcomingSessions = async (courseId, now, limit = 10) => {
    const sessions = await ClassSession.find({ course: courseId, status: { $in: ["scheduled", "live"] }, endsAt: { $gt: now } })
        .sort({ startsAt: 1 })
        .limit(limit)
        .lean();
    return sessions;
};

export const getCourseDetail = async (user, courseId, { now = new Date() } = {}) => {
    const course = await loadCourse(courseId, { lean: true });
    assertCanViewCourse(user, course);
    const populated = await Course.findById(course._id).populate("teacher", "name email").lean();
    const upcoming = (await upcomingSessions(course._id, now)).map((session) => serializeSession(session, { now, course }));
    const threshold = course.settings?.minAttendancePercent ?? DEFAULT_SETTINGS.minAttendancePercent;

    if (isOwner(user, course) || isOversight(user)) {
        const students = await User.find({ _id: { $in: course.students } }).select(STUDENT_CARD_FIELDS).lean();
        const summaries = await courseStudentSummaries(course, students.map((student) => student._id), threshold);
        return {
            course: serializeCourse(populated, { manage: true }),
            students: students
                .map((student) => ({ ...userCard(student), stats: summaries.get(String(student._id)) }))
                .sort((a, b) => (a.rollNumber || a.ggsipuEnrollment || a.name || "").localeCompare(b.rollNumber || b.ggsipuEnrollment || b.name || "")),
            upcoming,
        };
    }
    const summary = (await studentCourseSummaries(user._id, [course])).get(String(course._id));
    return { course: serializeCourse(populated, { manage: false }), summary, upcoming };
};

/** Per-student report of a course (owner / tpo / admin). */
export const courseReport = async (user, courseId, { threshold } = {}) => {
    const course = await loadCourse(courseId, { lean: true });
    assertCanReportCourse(user, course);
    return buildCourseReport(course, { threshold });
};

export const buildCourseReport = async (course, { threshold } = {}) => {
    const minimum = course.settings?.minAttendancePercent ?? DEFAULT_SETTINGS.minAttendancePercent;
    let limit = minimum;
    if (threshold !== undefined && threshold !== null && threshold !== "") {
        const value = Number(threshold);
        if (!Number.isFinite(value) || value < 0 || value > 100) throw validation("threshold must be between 0 and 100", "threshold");
        limit = value;
    }
    const students = await User.find({ _id: { $in: course.students } }).select(STUDENT_CARD_FIELDS).lean();
    const [summaries, heldMap, populated] = await Promise.all([
        courseStudentSummaries(course, students.map((student) => student._id), limit),
        heldByCourse([course._id]),
        Course.findById(course._id).populate("teacher", "name email").lean(),
    ]);
    const rows = students.map((student) => ({ student: userCard(student), ...summaries.get(String(student._id)) }));
    rows.sort((a, b) => {
        if (a.percent === null && b.percent !== null) return 1;
        if (b.percent === null && a.percent !== null) return -1;
        if (a.percent !== b.percent) return a.percent - b.percent;
        return (a.student.name || "").localeCompare(b.student.name || "");
    });
    return {
        course: serializeCourse(populated || course, { manage: true }),
        held: heldMap.get(String(course._id)) || 0,
        threshold: limit,
        students: rows,
        defaulters: rows.filter((row) => row.percent !== null && row.percent < limit),
    };
};

export const notifyDefaulters = async (user, courseId, { threshold, message } = {}, { now = new Date() } = {}) => {
    const course = await loadCourse(courseId, { lean: true });
    assertCanManageCourse(user, course);
    const text = message === undefined || message === null ? "" : String(message).trim();
    if (text.length > 500) throw validation("message must be at most 500 characters", "message");
    const report = await buildCourseReport(course, { threshold });
    const digest = crypto.createHash("sha1").update(`${report.threshold}|${text}`).digest("hex").slice(0, 10);
    let notified = 0;
    for (const row of report.defaulters) {
        const { created } = await notifyLowAttendance(row.student._id, course, row, report.threshold, {
            dedupeKey: `defaulters:${idString(course._id)}:${formatDate(now)}:${digest}`,
            message: text || null,
            email: true,
        });
        notified += created;
    }
    return {
        notified,
        defaulters: report.defaulters.length,
        alreadyNotified: report.defaulters.length - notified,
        threshold: report.threshold,
    };
};

