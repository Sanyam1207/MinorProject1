// Training programs, registrations, attendance and the status sweep
// (docs/contracts/PLACEMENTS.md §3.5, §3.6, §6.4, §7.5).
import mongoose from "mongoose";
import { assertObjectId, escapeRegex, fail, isObjectId } from "../../../core/http.js";
import { User } from "../../../models/user.models.js";
import {
    COMPLETION_STATUSES,
    DELIVERY_MODES,
    PROGRAM_STATUSES,
    TRAINING_TYPES,
    isStaff,
} from "../constants.js";
import { TrainingEnrollment } from "../models/training-enrollment.model.js";
import { TrainingProgram } from "../models/training-program.model.js";
import { clock, dayKey, formatDay, parseDateInput } from "../utils/dates.js";
import { enumList, httpsUrl, list, num, oneOf, str } from "../utils/input.js";
import { branchMatches } from "./branches.js";
import * as events from "./events.js";
import { withLock } from "./locks.js";
import { andFilters, collegeScope, notFound } from "./scope.js";
import { idOf, toEnrollmentView, toProgramView, toRosterEntryView } from "./views.js";

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));
const invalid = (field, message) => fail(400, message, "VALIDATION", { field });
const has = (body, key) => Object.hasOwn(body, key) && body[key] !== undefined;
const TIME_RE = /^\d{1,2}:\d{2}(\s*[-–]\s*\d{1,2}:\d{2})?$/;

// ── Audience ────────────────────────────────────────────────────────────────

/** Does a student match a program's audience (§7.5)? An unknown CGPA does not match a minimum. */
export const audienceMatches = (program, user) => {
    const audience = program?.audience || {};
    const branches = (audience.branches || []).filter((entry) => String(entry ?? "").trim());
    if (branches.length > 0 && !branchMatches(user?.branch, branches)) return false;
    const years = (audience.graduationYears || []).map((year) => String(year).trim()).filter(Boolean);
    if (years.length > 0) {
        const year = Number.parseInt(user?.passingYear, 10);
        if (!Number.isFinite(year) || !years.includes(String(year))) return false;
    }
    if (audience.minCgpa !== null && audience.minCgpa !== undefined) {
        const cgpa = Number(user?.cgpa);
        if (user?.cgpa === null || user?.cgpa === undefined || !Number.isFinite(cgpa) || cgpa < audience.minCgpa) return false;
    }
    return true;
};

const audienceStudentIds = async (program) => {
    const filter = { role: "student", isActive: { $ne: false } };
    if (program.college) filter.college = program.college;
    const students = await User.find(filter).select("branch passingYear cgpa").lean();
    return students.filter((student) => audienceMatches(program, student)).map((student) => String(student._id));
};

const registeredStudentIds = async (programId) => (await TrainingEnrollment.find({ program: programId, status: "registered" })
    .select("student").lean()).map((row) => String(row.student));

// ── Input ───────────────────────────────────────────────────────────────────

const normalizeSchedule = (value) => {
    if (!Array.isArray(value) || value.length < 1) throw invalid("schedule", "schedule needs at least one session");
    if (value.length > 60) throw invalid("schedule", "schedule accepts at most 60 sessions");
    const sessions = value.map((session, index) => {
        if (!session || typeof session !== "object") throw invalid("schedule", `schedule[${index}] must be an object`);
        const field = `schedule[${index}]`;
        if (session.date === undefined || session.date === null || session.date === "") throw invalid(`${field}.date`, `${field}.date is required`);
        const time = str(session.time, { field: `${field}.time`, max: 40 }) ?? "";
        if (time && !TIME_RE.test(time)) throw invalid(`${field}.time`, `${field}.time must look like 10:00 or 10:00-12:00`);
        return {
            ...(session._id && isObjectId(String(session._id)) ? { _id: toObjectId(session._id) } : {}),
            date: parseDateInput(session.date, { field: `${field}.date` }),
            time,
            venue: str(session.venue, { field: `${field}.venue`, max: 200 }) ?? "TBA",
            topic: str(session.topic, { field: `${field}.topic`, max: 200 }) ?? "",
            durationMinutes: num(session.durationMinutes, { field: `${field}.durationMinutes`, min: 15, max: 600, int: true }),
        };
    });
    return sessions.sort((a, b) => a.date - b.date);
};

const normalizeAudience = (value) => {
    if (value === undefined || value === null) return { branches: [], graduationYears: [], minCgpa: null };
    if (typeof value !== "object" || Array.isArray(value)) throw invalid("audience", "audience must be an object");
    const graduationYears = list(Array.isArray(value.graduationYears) ? value.graduationYears.map((year) => (year == null ? year : String(year))) : value.graduationYears,
        { maxItems: 10, maxLen: 10, field: "audience.graduationYears" });
    for (const year of graduationYears) {
        if (!/^\d{4}$/.test(year)) throw invalid("audience.graduationYears", "audience.graduationYears must be four-digit years");
    }
    return {
        branches: list(value.branches, { maxItems: 30, maxLen: 100, field: "audience.branches" }),
        graduationYears,
        minCgpa: num(value.minCgpa, { field: "audience.minCgpa", min: 0, max: 10 }) ?? null,
    };
};

const normalizeProgramInput = (body = {}, { partial = false } = {}) => {
    const set = {};
    if (has(body, "title") || !partial) set.title = str(body.title, { field: "title", min: 2, max: 200, required: true });
    if (has(body, "description")) set.description = str(body.description, { field: "description", max: 5000 }) ?? "";
    if (has(body, "type")) set.type = oneOf(body.type, TRAINING_TYPES, { field: "type" }) ?? "other";
    if (has(body, "instructor")) set.instructor = str(body.instructor, { field: "instructor", max: 120 }) ?? "";
    if (has(body, "deliveryMode")) set.deliveryMode = oneOf(body.deliveryMode, DELIVERY_MODES, { field: "deliveryMode" }) ?? "offline";
    if (has(body, "capacity") || !partial) set.capacity = num(body.capacity, { field: "capacity", min: 1, max: 100000, int: true, required: true });
    if (has(body, "schedule") || !partial) set.schedule = normalizeSchedule(body.schedule);
    if (has(body, "registrationDeadline")) {
        set.registrationDeadline = body.registrationDeadline === null || body.registrationDeadline === ""
            ? null
            : parseDateInput(body.registrationDeadline, { endOfDay: true, field: "registrationDeadline" });
    }
    if (has(body, "audience") || !partial) set.audience = normalizeAudience(body.audience);
    return set;
};

// ── Loading ─────────────────────────────────────────────────────────────────

const staffOnly = (user) => {
    if (!isStaff(user)) throw fail(403, "Only the placement office can manage training programs", "FORBIDDEN");
};

const programScope = (user) => {
    if (user.role === "company") throw fail(403, "Training programs are not available to recruiter accounts", "FORBIDDEN");
    return collegeScope(user);
};

/** A program in the caller's college scope (404 otherwise). */
export const loadProgramInScope = async (user, programId) => {
    assertObjectId(String(programId ?? ""), "programId");
    const program = await TrainingProgram.findOne(andFilters({ _id: toObjectId(programId) }, programScope(user))).lean();
    if (!program) throw notFound("Training program");
    return program;
};

const firstSessionTime = (program) => {
    const first = (program.schedule || []).reduce((min, session) => Math.min(min, new Date(session.date).getTime()), Number.POSITIVE_INFINITY);
    return first;
};

// ── Reads ───────────────────────────────────────────────────────────────────

/** GET /training → ProgramView[] sorted by first session. Students see audience matches only. */
export const listPrograms = async (user, query = {}) => {
    const parts = [programScope(user)];
    const statuses = query.status === undefined || query.status === ""
        ? ["upcoming", "ongoing"]
        : enumList(query.status, PROGRAM_STATUSES, { field: "status" });
    if (statuses) parts.push({ status: { $in: statuses } });
    const type = oneOf(query.type, TRAINING_TYPES, { field: "type" });
    if (type) parts.push({ type });
    const q = str(query.q, { field: "q", max: 200 });
    if (q) {
        const pattern = new RegExp(escapeRegex(q), "i");
        parts.push({ $or: [{ title: pattern }, { description: pattern }, { instructor: pattern }] });
    }
    let programs = await TrainingProgram.find(andFilters(...parts)).limit(500).lean();
    let registered = null;
    if (user.role === "student") {
        programs = programs.filter((program) => audienceMatches(program, user));
        const rows = await TrainingEnrollment.find({ student: user._id, status: "registered", program: { $in: programs.map((p) => p._id) } })
            .select("program").lean();
        registered = new Set(rows.map((row) => String(row.program)));
    }
    programs.sort((a, b) => firstSessionTime(a) - firstSessionTime(b));
    return programs.map((program) => toProgramView(program, registered ? { isRegistered: registered.has(String(program._id)) } : {}));
};

/** GET /training/my → EnrollmentView[] (registered only). */
export const listMyEnrollments = async (user) => {
    if (user.role !== "student") throw fail(403, "Student account required", "FORBIDDEN");
    const rows = await TrainingEnrollment.find({ student: user._id, status: "registered" }).populate("program").lean();
    return rows
        .filter((row) => row.program)
        .sort((a, b) => firstSessionTime(a.program) - firstSessionTime(b.program))
        .map((row) => toEnrollmentView(row));
};

/** GET /training/:id → ProgramView (+ myRegistration for students). */
export const getProgram = async (user, programId) => {
    const program = await loadProgramInScope(user, programId);
    if (user.role !== "student") return toProgramView(program);
    const registration = await TrainingEnrollment.findOne({ program: program._id, student: user._id }).lean();
    const view = toProgramView(program, { isRegistered: registration?.status === "registered" });
    view.myRegistration = registration ? { ...toEnrollmentView(registration), program: undefined } : null;
    if (view.myRegistration) delete view.myRegistration.program;
    view.audienceMatches = audienceMatches(program, user);
    return view;
};

// ── Staff management ────────────────────────────────────────────────────────

/** POST /training (tpo) → ProgramView; notifies the audience. */
export const createProgram = async (user, body = {}) => {
    staffOnly(user);
    const set = normalizeProgramInput(body, { partial: false });
    let college = user.college ?? null;
    if (user.role === "admin") {
        if (body.collegeId !== undefined && body.collegeId !== null && body.collegeId !== "") {
            assertObjectId(String(body.collegeId), "collegeId");
            college = toObjectId(body.collegeId);
        }
    }
    const program = await TrainingProgram.create({ ...set, college, createdBy: user._id, status: "upcoming", enrolledCount: 0 });
    const plain = program.toObject();
    events.trainingCreated(plain, await audienceStudentIds(plain));
    return toProgramView(plain);
};

const scheduleSignature = (schedule = []) => JSON.stringify((schedule || []).map((session) => [
    new Date(session.date).toISOString(), session.time || "", session.venue || "",
]));

const describeChange = (before, after) => {
    const first = after.schedule?.[0];
    const venueChanged = (before.schedule || []).some((session, index) => (after.schedule?.[index]?.venue || "") !== (session.venue || ""));
    const parts = ["The schedule changed."];
    if (venueChanged) parts.push(`Venue: ${first?.venue || "TBA"}.`);
    if (first) parts.push(`Next: ${formatDay(first.date)}${first.time ? ` ${first.time}` : ""}.`);
    return parts.join(" ");
};

/** PATCH /training/:id (tpo). Schedule/venue changes notify registered students. */
export const updateProgram = async (user, programId, body = {}) => {
    staffOnly(user);
    const program = await loadProgramInScope(user, programId);
    const set = normalizeProgramInput(body, { partial: true });
    if (set.capacity !== undefined && set.capacity < (program.enrolledCount || 0)) {
        throw invalid("capacity", `capacity cannot be below the ${program.enrolledCount} students already registered`);
    }
    if (Object.keys(set).length === 0) return toProgramView(program);
    const updated = await TrainingProgram.findOneAndUpdate({ _id: program._id }, { $set: set }, { returnDocument: "after", runValidators: true }).lean();
    if (!updated) throw notFound("Training program");
    if (set.schedule && scheduleSignature(program.schedule) !== scheduleSignature(updated.schedule)) {
        events.trainingUpdated(updated, await registeredStudentIds(updated._id), { summary: describeChange(program, updated) });
    }
    return toProgramView(updated);
};

/** POST /training/:id/cancel (tpo). */
export const cancelProgram = async (user, programId, { reason } = {}) => {
    staffOnly(user);
    const cleanReason = str(reason, { field: "reason", max: 500 }) ?? "";
    const program = await loadProgramInScope(user, programId);
    if (["completed", "cancelled"].includes(program.status)) throw fail(409, `A ${program.status} program cannot be cancelled`, "INVALID_TRANSITION");
    const updated = await TrainingProgram.findOneAndUpdate(
        { _id: program._id, status: program.status },
        { $set: { status: "cancelled", cancelReason: cleanReason } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) throw fail(409, "The program changed while it was being cancelled; reload and try again", "INVALID_TRANSITION");
    events.trainingUpdated(updated, await registeredStudentIds(updated._id), {
        cancelled: true,
        summary: cleanReason || "The placement office cancelled this program.",
    });
    return toProgramView(updated);
};

/** DELETE /training/:id (tpo) — only without registrations. */
export const deleteProgram = async (user, programId) => {
    staffOnly(user);
    const program = await loadProgramInScope(user, programId);
    const registered = await TrainingEnrollment.countDocuments({ program: program._id, status: "registered" });
    if (registered > 0) throw fail(409, `${registered} student(s) are registered; cancel the program instead`, "HAS_ENROLLMENTS");
    await TrainingEnrollment.deleteMany({ program: program._id });
    await TrainingProgram.deleteOne({ _id: program._id });
    return { deleted: true };
};

/** GET /training/:id/enrollments (tpo). */
export const listEnrollments = async (user, programId) => {
    staffOnly(user);
    const program = await loadProgramInScope(user, programId);
    const rows = await TrainingEnrollment.find({ program: program._id, status: "registered" })
        .populate("student", "name email branch passingYear rollNumber")
        .sort({ registeredAt: 1 })
        .lean();
    return { program: toProgramView(program), enrollments: rows.map(toRosterEntryView) };
};

/** POST /training/:id/attendance (tpo): idempotent per session index. */
export const markAttendance = async (user, programId, { sessionIndex, studentIds, present } = {}) => {
    staffOnly(user);
    const program = await loadProgramInScope(user, programId);
    const sessions = [...(program.schedule || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
    const index = num(sessionIndex, { field: "sessionIndex", min: 0, max: Math.max(0, sessions.length - 1), int: true, required: true });
    if (!Array.isArray(studentIds) || studentIds.length < 1 || studentIds.length > 1000) {
        throw invalid("studentIds", "studentIds must list between 1 and 1000 student ids");
    }
    const ids = studentIds.map((id) => assertObjectId(String(id ?? ""), "studentIds")).map(toObjectId);
    if (typeof present !== "boolean" && !["true", "false"].includes(present)) throw invalid("present", "present must be true or false");
    const isPresent = present === true || present === "true";
    let result;
    if (isPresent) {
        result = await TrainingEnrollment.updateMany(
            { program: program._id, student: { $in: ids }, status: "registered", "attendance.sessionIndex": { $ne: index } },
            { $push: { attendance: { sessionIndex: index, date: sessions[index].date, markedAt: clock.now(), markedBy: user._id, method: "manual" } } },
        );
    } else {
        result = await TrainingEnrollment.updateMany(
            { program: program._id, student: { $in: ids } },
            { $pull: { attendance: { sessionIndex: index } } },
        );
    }
    return { updated: result.modifiedCount };
};

/** PATCH /training/:id/enrollments/:enrollmentId (tpo). */
export const updateEnrollment = async (user, programId, enrollmentId, body = {}) => {
    staffOnly(user);
    const program = await loadProgramInScope(user, programId);
    assertObjectId(String(enrollmentId ?? ""), "enrollmentId");
    const set = {};
    if (has(body, "completionStatus")) set.completionStatus = oneOf(body.completionStatus, COMPLETION_STATUSES, { field: "completionStatus", required: true });
    if (has(body, "certificateUrl")) {
        set.certificateUrl = body.certificateUrl === null || body.certificateUrl === ""
            ? null
            : httpsUrl(body.certificateUrl, { field: "certificateUrl" });
    }
    if (Object.keys(set).length === 0) throw invalid("completionStatus", "Send completionStatus and/or certificateUrl");
    const updated = await TrainingEnrollment.findOneAndUpdate(
        { _id: toObjectId(enrollmentId), program: program._id },
        { $set: set },
        { returnDocument: "after", runValidators: true },
    ).populate("program").lean();
    if (!updated) throw notFound("Enrollment");
    return { enrollment: toEnrollmentView(updated) };
};

// ── Student registration ────────────────────────────────────────────────────

/** Read-only registration checks (also the training_register preview). */
export const checkRegistration = async (user, programId) => {
    if (user.role !== "student") throw fail(403, "Only students can register for training", "FORBIDDEN");
    const program = await loadProgramInScope(user, programId);
    if (!["upcoming", "ongoing"].includes(program.status)) throw fail(409, `This program is ${program.status}`, "PROGRAM_CLOSED");
    if (program.registrationDeadline && new Date(program.registrationDeadline).getTime() <= clock.now().getTime()) {
        throw fail(409, "Registration for this program has closed", "REGISTRATION_CLOSED");
    }
    if (!audienceMatches(program, user)) throw fail(403, "This program is not open to your branch, batch or CGPA", "NOT_ELIGIBLE");
    const existing = await TrainingEnrollment.findOne({ program: program._id, student: user._id }).lean();
    if (existing?.status === "registered") throw fail(409, "You are already registered for this program", "ALREADY_REGISTERED");
    if ((program.enrolledCount || 0) >= program.capacity) throw fail(409, "This program is full", "PROGRAM_FULL");
    return { program, existing };
};

/** POST /training/:id/register → {enrollment, created}. */
export const registerForProgram = async (user, programId) => {
    assertObjectId(String(programId ?? ""), "programId");
    return withLock(`training:${user._id}:${programId}`, async () => {
        const { program, existing } = await checkRegistration(user, programId);
        const claimed = await TrainingProgram.findOneAndUpdate(
            { _id: program._id, status: { $in: ["upcoming", "ongoing"] }, $expr: { $lt: ["$enrolledCount", "$capacity"] } },
            { $inc: { enrolledCount: 1 } },
            { returnDocument: "after" },
        ).lean();
        if (!claimed) throw fail(409, "This program is full", "PROGRAM_FULL");
        const release = () => TrainingProgram.updateOne({ _id: program._id, enrolledCount: { $gt: 0 } }, { $inc: { enrolledCount: -1 } });
        const now = clock.now();
        const completionStatus = claimed.status === "ongoing" ? "in-progress" : "enrolled";
        let enrollment;
        try {
            if (existing) {
                enrollment = await TrainingEnrollment.findOneAndUpdate(
                    { _id: existing._id, status: "cancelled" },
                    { $set: { status: "registered", completionStatus, registeredAt: now } },
                    { returnDocument: "after" },
                ).lean();
                if (!enrollment) throw fail(409, "You are already registered for this program", "ALREADY_REGISTERED");
            } else {
                enrollment = (await TrainingEnrollment.create({
                    program: program._id, student: user._id, status: "registered", completionStatus, registeredAt: now,
                })).toObject();
            }
        } catch (error) {
            await release();
            if (error?.code === 11000) throw fail(409, "You are already registered for this program", "ALREADY_REGISTERED");
            throw error;
        }
        enrollment.program = claimed;
        return { enrollment: toEnrollmentView(enrollment), created: !existing };
    });
};

/** DELETE /training/:id/register → {enrollment} (cancelled). */
export const unregisterFromProgram = async (user, programId) => {
    if (user.role !== "student") throw fail(403, "Only students can unregister", "FORBIDDEN");
    const program = await loadProgramInScope(user, programId);
    const registration = await TrainingEnrollment.findOne({ program: program._id, student: user._id, status: "registered" }).lean();
    if (!registration) throw fail(404, "You are not registered for this program", "NOT_REGISTERED");
    if (program.status !== "upcoming") throw fail(409, "This program has already started; ask the placement office", "PROGRAM_CLOSED");
    const updated = await TrainingEnrollment.findOneAndUpdate(
        { _id: registration._id, status: "registered" },
        { $set: { status: "cancelled" } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) throw fail(404, "You are not registered for this program", "NOT_REGISTERED");
    const refreshed = await TrainingProgram.findOneAndUpdate(
        { _id: program._id, enrolledCount: { $gt: 0 } },
        { $inc: { enrolledCount: -1 } },
        { returnDocument: "after" },
    ).lean();
    updated.program = refreshed || program;
    return { enrollment: toEnrollmentView(updated) };
};

// ── Sweep (§7.5) ────────────────────────────────────────────────────────────

/** upcoming → ongoing (first session day reached) → completed (after the last session day). */
export const sweepTrainingStatuses = async () => {
    const today = dayKey(clock.now());
    let started = 0;
    let completed = 0;
    const upcoming = await TrainingProgram.find({ status: "upcoming" }).select("schedule status").limit(500).lean();
    for (const program of upcoming) {
        const days = (program.schedule || []).map((session) => dayKey(session.date)).filter(Boolean).sort();
        if (days.length === 0 || days[0] > today) continue;
        const moved = await TrainingProgram.updateOne({ _id: program._id, status: "upcoming" }, { $set: { status: "ongoing" } });
        if (moved.modifiedCount === 1) {
            started += 1;
            await TrainingEnrollment.updateMany(
                { program: program._id, status: "registered", completionStatus: "enrolled" },
                { $set: { completionStatus: "in-progress" } },
            );
        }
    }
    const ongoing = await TrainingProgram.find({ status: "ongoing" }).select("schedule").limit(500).lean();
    for (const program of ongoing) {
        const days = (program.schedule || []).map((session) => dayKey(session.date)).filter(Boolean).sort();
        if (days.length === 0 || days[days.length - 1] >= today) continue;
        const moved = await TrainingProgram.updateOne({ _id: program._id, status: "ongoing" }, { $set: { status: "completed" } });
        if (moved.modifiedCount === 1) completed += 1;
    }
    return { started, completed };
};

export const programIdOf = (program) => idOf(program?._id);
