// Class sessions: manual + automatic scheduling with conflict detection,
// timetable materialisation, start (QR) / end (finalise), manual marking,
// role-scoped lists, detail, CSV export (ATTENDANCE.md "Sessions").
import mongoose from "mongoose";
import { fail, intParam, isObjectId } from "../../core/http.js";
import { User } from "../../models/user.models.js";
import {
    assertCanManageCourse,
    assertCanManageSession,
    assertCanReportSession,
    isEnrolled,
    isOversight,
    isOwner,
    loadCourse,
    loadSession,
} from "./access.js";
import {
    ACTIVE_SESSION_STATUSES,
    DEFAULT_DURATION_MINUTES,
    DEFAULT_SETTINGS,
    MAX_DURATION_MINUTES,
    MIN_DURATION_MINUTES,
    RECORD_STATUSES,
    SESSION_MODES,
    SESSION_STATUSES,
    SLOT_STEP_MINUTES,
    START_EARLY_MINUTES,
    parseHHmm,
    parseWeekday,
    weekdayName,
    workDays,
    workHours,
} from "./config.js";
import { emitMarked, emitSessionChanged } from "./events.js";
import { AttendanceRecord, ClassSession, Course } from "./models/index.js";
import {
    notifyCancelled,
    notifyLive,
    notifyLowAttendance,
    notifyManualMark,
    notifyRescheduled,
    notifyScheduled,
    safeNotify,
    studentScheduleUi,
    teacherScheduleUi,
} from "./notifications.js";
import { freshTokenFields, newNonce, qrPayload, rotateIfExpired } from "./qr.js";
import { courseRef, idString, sameId, serializeCourse, serializeRecord, serializeSession, userCard } from "./serializers.js";
import { countRecords, recountSessionStats, summarise } from "./stats.js";
import {
    ceilToGrid,
    contractWeekday,
    formatDate,
    formatDateTime,
    formatDay,
    formatSlot,
    formatTime,
    parseDateInput,
    toLocal,
    zone,
} from "./time.js";

const STUDENT_CARD_FIELDS = "name email ggsipuEnrollment rollNumber branch section";
const MAX_SCHEDULE_AHEAD_DAYS = 366;
const PAST_TOLERANCE_MS = 5 * 60_000;

const validation = (message, field) => fail(400, message, "VALIDATION", field ? { field } : {});
const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

// ── field helpers ──────────────────────────────────────────────────────────

export const parseDuration = (value, fallback = DEFAULT_DURATION_MINUTES) => {
    if (value === undefined || value === null || value === "") return fallback;
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
        throw validation(`durationMinutes must be a whole number between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}`, "durationMinutes");
    }
    return minutes;
};

const optionalString = (value, field, max) => {
    if (value === undefined) return undefined;
    if (value === null) return "";
    if (typeof value !== "string" && typeof value !== "number") throw validation(`${field} must be text`, field);
    const text = String(value).trim();
    if (text.length > max) throw validation(`${field} must be at most ${max} characters`, field);
    return text;
};

const parseMode = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const mode = String(value).trim().toLowerCase();
    if (!SESSION_MODES.includes(mode)) throw validation(`mode must be one of ${SESSION_MODES.join(", ")}`, "mode");
    return mode;
};

/** {lat, lng, accuracy} or null when absent; strict=true throws on malformed input. */
export const parseGeo = (value, { strict = false } = {}) => {
    if (value === undefined || value === null || value === "") return null;
    const lat = Number(value?.lat ?? value?.latitude);
    const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
    const accuracyRaw = value?.accuracy;
    const accuracy = accuracyRaw === undefined || accuracyRaw === null || accuracyRaw === "" ? null : Number(accuracyRaw);
    const valid = Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180
        && (accuracy === null || (Number.isFinite(accuracy) && accuracy >= 0));
    if (!valid) {
        if (strict) throw validation("geo must be {lat, lng, accuracy?} with valid coordinates", "geo");
        return null;
    }
    return { lat, lng, accuracy };
};

const assertNotPast = (startsAt, now, field) => {
    if (startsAt.getTime() < now.getTime() - PAST_TOLERANCE_MS) throw validation(`That ${field === "when" ? "time" : field} is in the past`, field);
    if (startsAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 86_400_000) throw validation("Classes can be scheduled at most a year ahead", field);
};

/** Start time from `{startsAt | when}`; `baseDate` keeps the day when only a time is given. */
export const resolveStart = (body, { now = new Date(), baseSession = null } = {}) => {
    const field = body.startsAt !== undefined && body.startsAt !== null && body.startsAt !== "" ? "startsAt" : "when";
    const input = body[field];
    if (input === undefined || input === null || input === "") return null;
    const parsed = parseDateInput(input, { field, now, baseDate: baseSession?.startsAt || null, requireTime: !baseSession });
    let startsAt = parsed.date;
    if (!parsed.hasTime && baseSession) {
        // "move it to friday" keeps the class's time of day.
        const original = toLocal(baseSession.startsAt);
        startsAt = toLocal(parsed.dayStart).set({ hour: original.hour, minute: original.minute, second: 0, millisecond: 0 }).toJSDate();
    }
    assertNotPast(startsAt, now, field);
    return { startsAt, field };
};

// ── conflicts ──────────────────────────────────────────────────────────────

/** Non-cancelled sessions overlapping [startsAt, endsAt) of the teacher, the course or `extraCourseIds`. */
export const findConflicts = async ({ teacherId, courseId, startsAt, endsAt, excludeId = null, extraCourseIds = [] }) => {
    const or = [{ teacher: toObjectId(teacherId) }, { course: toObjectId(courseId) }];
    if (extraCourseIds.length) or.push({ course: { $in: extraCourseIds.map(toObjectId) } });
    const filter = {
        status: { $in: [...ACTIVE_SESSION_STATUSES] },
        startsAt: { $lt: endsAt },
        endsAt: { $gt: startsAt },
        $or: or,
    };
    if (excludeId) filter._id = { $ne: toObjectId(excludeId) };
    const sessions = await ClassSession.find(filter).populate("course", "code name").sort({ startsAt: 1 }).limit(20).lean();
    return sessions.map((session) => ({
        sessionId: idString(session._id),
        course: courseRef(session.course),
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        status: session.status,
    }));
};

export const conflictError = (conflicts) => {
    const first = conflicts[0];
    const label = first ? `${first.course?.code || "another class"} (${formatSlot(first.startsAt, first.endsAt)})` : "another class";
    return fail(409, `That time overlaps ${label}`, "SCHEDULE_CONFLICT", { conflicts });
};

const assertNoConflicts = async (args) => {
    const conflicts = await findConflicts(args);
    if (conflicts.length) throw conflictError(conflicts);
};

const isDuplicateStart = (error) => error?.code === 11000 && Object.keys(error.keyPattern || error.keyValue || {}).includes("startsAt");

// ── create ─────────────────────────────────────────────────────────────────

const assertActiveCourse = (course) => {
    if (course.status !== "active") throw fail(409, "This course is archived", "INVALID_STATE");
};

/**
 * Validate a new session for `course` without writing anything.
 * @returns {Promise<{startsAt: Date, endsAt: Date, durationMinutes: number, room, topic, mode}>}
 */
export const planSession = async (user, course, body = {}, { now = new Date() } = {}) => {
    assertCanManageCourse(user, course);
    assertActiveCourse(course);
    const start = resolveStart(body, { now });
    if (!start) throw validation("startsAt or when is required", "startsAt");
    const durationMinutes = parseDuration(body.durationMinutes);
    const startsAt = start.startsAt;
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const plan = {
        startsAt,
        endsAt,
        durationMinutes,
        room: optionalString(body.room, "room", 60) || course.room || undefined,
        topic: optionalString(body.topic, "topic", 200) || "",
        mode: parseMode(body.mode) || "offline",
    };
    await assertNoConflicts({ teacherId: user._id, courseId: course._id, startsAt, endsAt });
    return plan;
};

const insertSession = async (user, course, plan, source) => {
    try {
        return await ClassSession.create({
            course: course._id,
            teacher: course.teacher || user._id,
            topic: plan.topic || "",
            room: plan.room,
            mode: plan.mode || "offline",
            startsAt: plan.startsAt,
            endsAt: plan.endsAt,
            status: "scheduled",
            source,
            stats: { present: 0, late: 0, absent: 0, excused: 0, enrolled: (course.students || []).length },
        });
    } catch (error) {
        if (isDuplicateStart(error)) {
            const conflicts = await findConflicts({ teacherId: user._id, courseId: course._id, startsAt: plan.startsAt, endsAt: plan.endsAt });
            throw conflictError(conflicts);
        }
        throw error;
    }
};

const announceNewSession = async (session, course) => {
    const { created } = await notifyScheduled(session, course);
    emitSessionChanged(session, course);
    return created;
};

/** POST /sessions → {session, course, notified}. */
export const createSession = async (user, body = {}, { source = "manual", now = new Date() } = {}) => {
    const course = await loadCourse(body.courseId ?? body.course);
    const plan = await planSession(user, course, body, { now });
    // Re-check right before writing: another request may have taken the slot.
    await assertNoConflicts({ teacherId: user._id, courseId: course._id, startsAt: plan.startsAt, endsAt: plan.endsAt });
    const session = await insertSession(user, course, plan, source);
    const notified = await announceNewSession(session, course);
    return { session, course, notified };
};

// ── auto-schedule ──────────────────────────────────────────────────────────

const parseDayList = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
    const days = [];
    for (const entry of list) {
        if (entry === "" || entry === null || entry === undefined) continue;
        const day = parseWeekday(entry);
        if (day === null) throw validation(`"${entry}" is not a weekday (use 0-6, 0 = Sunday, or names like "mon")`, "preferredDays");
        if (!days.includes(day)) days.push(day);
    }
    return days.length ? days.sort((a, b) => a - b) : null;
};

const parseClock = (value, field) => {
    if (value === undefined || value === null || value === "") return null;
    const clock = parseHHmm(value);
    if (!clock) throw validation(`${field} must be "HH:mm"`, field);
    return clock;
};

/**
 * Normalised auto-schedule window and constraints.
 * earliest default: now + 1 h rounded up to 15 min; latest default: earliest + 7 days.
 */
export const resolveAutoOptions = (body = {}, { now = new Date() } = {}) => {
    const durationMinutes = parseDuration(body.durationMinutes);
    let from;
    if (body.earliest !== undefined && body.earliest !== null && body.earliest !== "") {
        const parsed = parseDateInput(body.earliest, { field: "earliest", now });
        from = parsed.hasTime ? parsed.date : parsed.dayStart;
        if (from < now) from = now;
    } else {
        from = new Date(now.getTime() + 60 * 60_000);
    }
    from = ceilToGrid(from, SLOT_STEP_MINUTES);
    let to;
    if (body.latest !== undefined && body.latest !== null && body.latest !== "") {
        const parsed = parseDateInput(body.latest, { field: "latest", now });
        to = parsed.hasTime ? parsed.date : parsed.dayEnd;
    } else {
        to = new Date(from.getTime() + 7 * 86_400_000);
    }
    if (to.getTime() - from.getTime() > 60 * 86_400_000) to = new Date(from.getTime() + 60 * 86_400_000);
    if (to <= from) throw validation("latest must be after earliest", "latest");

    const hours = workHours();
    const dayStart = parseClock(body.preferredStart, "preferredStart") || hours.start;
    const dayEnd = parseClock(body.preferredEnd, "preferredEnd") || hours.end;
    if (dayEnd.minutes - dayStart.minutes < durationMinutes) {
        throw validation(`The daily window ${dayStart.text}–${dayEnd.text} is shorter than ${durationMinutes} minutes`, "preferredEnd");
    }
    const days = parseDayList(body.preferredDays) || workDays();
    return { durationMinutes, from, to, dayStart, dayEnd, days };
};

/** Active courses (other than `course`) that share at least one enrolled student. */
export const sharedStudentCourseIds = async (course) => {
    if (!course.students?.length) return [];
    return Course.find({ _id: { $ne: course._id }, status: "active", students: { $in: course.students } }).distinct("_id");
};

/**
 * Earliest free slot on the 15-minute grid avoiding the teacher's sessions, the
 * course's sessions and sessions of courses sharing students. No writes.
 * @returns {Promise<{startsAt: Date, endsAt: Date, busy: number, sharedCourses: number} | null>}
 */
export const findFreeSlot = async ({ course, teacherId, durationMinutes, from, to, dayStart, dayEnd, days }) => {
    const sharedIds = await sharedStudentCourseIds(course);
    const or = [{ teacher: toObjectId(teacherId) }, { course: course._id }];
    if (sharedIds.length) or.push({ course: { $in: sharedIds } });
    const busy = await ClassSession.find({
        status: { $in: [...ACTIVE_SESSION_STATUSES] },
        startsAt: { $lt: to },
        endsAt: { $gt: from },
        $or: or,
    }).select("startsAt endsAt course").sort({ startsAt: 1 }).lean();

    const durationMs = durationMinutes * 60_000;
    let day = toLocal(from).startOf("day");
    const lastDay = toLocal(to).startOf("day");
    while (day <= lastDay) {
        if (days.includes(contractWeekday(day))) {
            const windowStart = day.set({ hour: dayStart.hour, minute: dayStart.minute });
            const windowEnd = day.set({ hour: dayEnd.hour, minute: dayEnd.minute });
            let cursor = windowStart.toJSDate();
            if (cursor < from) cursor = from;
            cursor = ceilToGrid(cursor, SLOT_STEP_MINUTES);
            while (cursor.getTime() + durationMs <= windowEnd.toJSDate().getTime() && cursor.getTime() + durationMs <= to.getTime()) {
                const end = new Date(cursor.getTime() + durationMs);
                const clash = busy.find((entry) => entry.startsAt < end && entry.endsAt > cursor);
                if (!clash) return { startsAt: cursor, endsAt: end, busy: busy.length, sharedCourses: sharedIds.length };
                const next = ceilToGrid(clash.endsAt, SLOT_STEP_MINUTES);
                cursor = next > cursor ? next : new Date(cursor.getTime() + SLOT_STEP_MINUTES * 60_000);
            }
        }
        day = day.plus({ days: 1 });
    }
    return null;
};

const describeDays = (days) => (days.length === 7 ? "any day" : days.map(weekdayName).join("/"));

/** Plan an automatic slot (no writes): {course, slot, options, reason}. Throws NO_FREE_SLOT. */
export const planAutoSession = async (user, course, body = {}, { now = new Date() } = {}) => {
    assertCanManageCourse(user, course);
    assertActiveCourse(course);
    const options = resolveAutoOptions(body, { now });
    const slot = await findFreeSlot({ course, teacherId: user._id, ...options });
    if (!slot) {
        throw fail(
            409,
            `No free ${options.durationMinutes}-minute slot for ${course.code} between ${formatDay(options.from)} and ${formatDay(options.to)} (${options.dayStart.text}–${options.dayEnd.text}, ${describeDays(options.days)})`,
            "NO_FREE_SLOT",
        );
    }
    const avoided = slot.sharedCourses
        ? `your classes, ${course.code}'s classes and ${slot.sharedCourses} other course${slot.sharedCourses === 1 ? "" : "s"} sharing students`
        : `your classes and ${course.code}'s classes`;
    const reason = `Earliest free slot ${formatSlot(slot.startsAt, slot.endsAt)} between ${formatDay(options.from)} and ${formatDay(options.to)}`
        + ` within ${options.dayStart.text}–${options.dayEnd.text} (${describeDays(options.days)}), avoiding ${avoided}.`;
    return { slot, options, reason };
};

/** POST /sessions/auto → {session, course, reason, notified}. */
export const autoScheduleSession = async (user, body = {}, { source = "auto", now = new Date() } = {}) => {
    const course = await loadCourse(body.courseId ?? body.course);
    const { slot, options, reason } = await planAutoSession(user, course, body, { now });
    const plan = {
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        durationMinutes: options.durationMinutes,
        room: optionalString(body.room, "room", 60) || course.room || undefined,
        topic: optionalString(body.topic, "topic", 200) || "",
        mode: parseMode(body.mode) || "offline",
    };
    await assertNoConflicts({ teacherId: user._id, courseId: course._id, startsAt: plan.startsAt, endsAt: plan.endsAt });
    const session = await insertSession(user, course, plan, source);
    const notified = await announceNewSession(session, course);
    return { session, course, reason, notified };
};

// ── update / cancel ────────────────────────────────────────────────────────

/** Validate a reschedule/edit without writing: {session, course, set, timeChanged, noticeChanged}. */
export const planUpdate = async (user, sessionId, body = {}, { now = new Date() } = {}) => {
    const { session, course } = await loadSession(sessionId);
    assertCanManageSession(user, session, course);
    if (session.status !== "scheduled") {
        throw fail(409, `Only scheduled classes can be changed (this one is ${session.status})`, "INVALID_STATE");
    }
    const start = resolveStart(body, { now, baseSession: session });
    const currentMinutes = Math.round((session.endsAt - session.startsAt) / 60_000);
    const durationMinutes = parseDuration(body.durationMinutes, currentMinutes);
    const startsAt = start ? start.startsAt : session.startsAt;
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const set = {};
    if (startsAt.getTime() !== session.startsAt.getTime()) set.startsAt = startsAt;
    if (endsAt.getTime() !== session.endsAt.getTime()) set.endsAt = endsAt;
    const room = optionalString(body.room, "room", 60);
    if (room !== undefined && room !== (session.room || "")) set.room = room;
    const topic = optionalString(body.topic, "topic", 200);
    if (topic !== undefined && topic !== (session.topic || "")) set.topic = topic;
    const mode = parseMode(body.mode);
    if (mode !== undefined && mode !== session.mode) set.mode = mode;
    const timeChanged = "startsAt" in set || "endsAt" in set;
    if (timeChanged) await assertNoConflicts({ teacherId: session.teacher, courseId: course._id, startsAt, endsAt, excludeId: session._id });
    return { session, course, set, timeChanged, noticeChanged: timeChanged || "room" in set || "mode" in set };
};

/** PATCH /sessions/:id → {session, course, changed}. */
export const updateSession = async (user, sessionId, body = {}, { now = new Date() } = {}) => {
    const { session, course, set, timeChanged, noticeChanged } = await planUpdate(user, sessionId, body, { now });
    if (!Object.keys(set).length) return { session, course, changed: false };
    const update = { $set: set };
    if (timeChanged) update.$unset = { reminderSentAt: "" };
    let updated;
    try {
        updated = await ClassSession.findOneAndUpdate({ _id: session._id, status: "scheduled" }, update, { returnDocument: "after" });
    } catch (error) {
        if (isDuplicateStart(error)) {
            throw conflictError(await findConflicts({
                teacherId: session.teacher, courseId: course._id, startsAt: set.startsAt || session.startsAt, endsAt: set.endsAt || session.endsAt, excludeId: session._id,
            }));
        }
        throw error;
    }
    if (!updated) throw fail(409, "This class is no longer scheduled", "INVALID_STATE");
    if (noticeChanged) await notifyRescheduled(updated, course, timeChanged ? { startsAt: session.startsAt, endsAt: session.endsAt } : null);
    emitSessionChanged(updated, course);
    return { session: updated, course, changed: true, previous: { startsAt: session.startsAt, endsAt: session.endsAt } };
};

export const planCancel = async (user, sessionId, { reason } = {}) => {
    const { session, course } = await loadSession(sessionId);
    assertCanManageSession(user, session, course);
    if (!["scheduled", "live"].includes(session.status)) {
        throw fail(409, `Only scheduled or live classes can be cancelled (this one is ${session.status})`, "INVALID_STATE");
    }
    const text = optionalString(reason, "reason", 300) || "";
    return { session, course, reason: text };
};

/** POST /sessions/:id/cancel → {session, course}. */
export const cancelSession = async (user, sessionId, { reason } = {}, { now = new Date() } = {}) => {
    const plan = await planCancel(user, sessionId, { reason });
    const set = { status: "cancelled", cancelledAt: now };
    if (plan.reason) set.cancelReason = plan.reason;
    if (plan.session.status === "live") Object.assign(set, { "qr.nonce": newNonce(), "qr.expiresAt": now });
    const updated = await ClassSession.findOneAndUpdate(
        { _id: plan.session._id, status: { $in: ["scheduled", "live"] } },
        { $set: set },
        { returnDocument: "after" },
    );
    if (!updated) throw fail(409, "This class can no longer be cancelled", "INVALID_STATE");
    await notifyCancelled(updated, plan.course);
    emitSessionChanged(updated, plan.course);
    return { session: updated, course: plan.course };
};

// ── start / end ────────────────────────────────────────────────────────────

/** Checks for starting a session (no writes). Returns {session, course, alreadyLive}. */
export const planStart = async (user, sessionId, { now = new Date() } = {}) => {
    const { session, course } = await loadSession(sessionId);
    assertCanManageSession(user, session, course);
    if (session.status === "live") return { session, course, alreadyLive: true };
    if (session.status !== "scheduled") {
        throw fail(409, `This class is ${session.status} and can't be started`, "INVALID_STATE");
    }
    const opensAt = new Date(session.startsAt.getTime() - START_EARLY_MINUTES * 60_000);
    if (now < opensAt) {
        throw fail(409, `You can start this class from ${formatTime(opensAt)} on ${formatDay(opensAt)}`, "INVALID_STATE", { opensAt });
    }
    if (now >= session.endsAt) {
        throw fail(409, "This class's time is over — reschedule it to take attendance", "INVALID_STATE");
    }
    return { session, course, alreadyLive: false };
};

/** POST /sessions/:id/start → {session (with nonce), course, qr, alreadyLive}. */
export const startSession = async (user, sessionId, { geo } = {}, { now = new Date() } = {}) => {
    const plan = await planStart(user, sessionId, { now });
    const { course } = plan;
    if (plan.alreadyLive) {
        const { session } = await rotateIfExpired(plan.session._id, now);
        if (!session) throw fail(409, "This class is no longer live", "SESSION_NOT_LIVE");
        return { session, course, qr: qrPayload(session), alreadyLive: true };
    }
    const point = parseGeo(geo, { strict: true });
    const settings = { ...DEFAULT_SETTINGS, ...(course.settings?.toObject?.() || course.settings || {}) };
    if (settings.requireGeo && !point) {
        throw fail(400, "This course checks students' location: allow location access to start attendance", "LOCATION_REQUIRED");
    }
    const rotationSeconds = settings.qrRotationSeconds;
    const set = {
        status: "live",
        liveStartedAt: now,
        ...freshTokenFields(rotationSeconds, now),
        "qr.version": 1,
        "qr.rotationSeconds": rotationSeconds,
        "stats.enrolled": (course.students || []).length,
    };
    if (point) {
        set.geo = { lat: point.lat, lng: point.lng, radiusMeters: settings.geoRadiusMeters };
        if (point.accuracy !== null) set.geo.accuracy = point.accuracy;
    }
    const live = await ClassSession.findOneAndUpdate(
        { _id: plan.session._id, status: "scheduled" },
        { $set: set },
        { returnDocument: "after" },
    ).select("+qr.nonce");
    if (!live) {
        // A concurrent start won the race: behave like "already live".
        const { session } = await rotateIfExpired(plan.session._id, now);
        if (!session) throw fail(409, "This class can no longer be started", "INVALID_STATE");
        return { session, course, qr: qrPayload(session), alreadyLive: true };
    }
    await notifyLive(live, course);
    emitSessionChanged(live, course);
    return { session: live, course, qr: qrPayload(live), alreadyLive: false };
};

/** Students below the threshold after this session: those who just dropped below, and those who missed it. */
const notifyLowAfterSession = async (session, course) => {
    const threshold = course.settings?.minAttendancePercent ?? DEFAULT_SETTINGS.minAttendancePercent;
    const students = (course.students || []).map(String);
    if (!students.length) return 0;
    const [counts, records] = await Promise.all([
        countRecords({ courseIds: [course._id], studentIds: students, groupBy: "student" }),
        AttendanceRecord.find({ session: session._id }).select("student status").lean(),
    ]);
    const thisSession = new Map(records.map((record) => [String(record.student), record.status]));
    let notified = 0;
    for (const studentId of students) {
        const current = counts.get(studentId);
        if (!current) continue;
        const summary = summarise(current, threshold);
        if (summary.percent === null || summary.percent >= threshold) continue;
        const mine = thisSession.get(studentId);
        const before = { ...current };
        if (mine && before[mine] > 0) before[mine] -= 1;
        const previous = summarise(before, threshold);
        const dropped = previous.percent === null || previous.percent >= threshold;
        if (!dropped && mine !== "absent") continue;
        const { created } = await notifyLowAttendance(studentId, course, summary, threshold, { dedupeKey: `low:${idString(session._id)}` });
        notified += created;
    }
    return notified;
};

/**
 * Finalise a live session: ended + QR invalidated + absentees filled + stats
 * recomputed + attendance:session + low-attendance notices.
 * @returns {Promise<{session, course, stats} | null>} null when the session was not live
 */
export const finaliseSession = async (sessionId, { now = new Date() } = {}) => {
    const ended = await ClassSession.findOneAndUpdate(
        { _id: sessionId, status: "live" },
        { $set: { status: "ended", endedAt: now, "qr.nonce": newNonce(), "qr.expiresAt": now } },
        { returnDocument: "after" },
    );
    if (!ended) return null;
    const course = await Course.findById(ended.course).lean();
    const enrolled = (course?.students || []).map(String);
    const marked = new Set((await AttendanceRecord.find({ session: ended._id }).distinct("student")).map(String));
    const missing = enrolled.filter((studentId) => !marked.has(studentId));
    if (missing.length) {
        try {
            await AttendanceRecord.bulkWrite(missing.map((studentId) => ({
                updateOne: {
                    filter: { session: ended._id, student: toObjectId(studentId) },
                    update: { $setOnInsert: { course: ended.course, status: "absent", method: "auto", markedAt: now, flags: [] } },
                    upsert: true,
                },
            })), { ordered: false });
        } catch (error) {
            // A concurrent manual mark created some of these records first: only duplicates are tolerated.
            const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
            const onlyDuplicates = writeErrors.length
                ? writeErrors.every((entry) => (entry?.code ?? entry?.err?.code) === 11000)
                : error?.code === 11000;
            if (!onlyDuplicates) throw error;
        }
    }
    const stats = await recountSessionStats(ended._id, enrolled.length);
    const final = await ClassSession.findOneAndUpdate({ _id: ended._id }, { $set: { stats } }, { returnDocument: "after" });
    if (course) {
        emitSessionChanged(final, course);
        await notifyLowAfterSession(final, course);
    }
    return { session: final, course, stats };
};

export const planEnd = async (user, sessionId) => {
    const { session, course } = await loadSession(sessionId);
    assertCanManageSession(user, session, course);
    if (session.status !== "live" && session.status !== "ended") {
        throw fail(409, `Only a live class can be ended (this one is ${session.status})`, "SESSION_NOT_LIVE");
    }
    return { session, course };
};

/** POST /sessions/:id/end → {session, course, stats}; ending an ended session is a no-op. */
export const endSession = async (user, sessionId, { now = new Date() } = {}) => {
    const plan = await planEnd(user, sessionId);
    if (plan.session.status === "ended") return { session: plan.session, course: plan.course, stats: plan.session.stats, alreadyEnded: true };
    const result = await finaliseSession(plan.session._id, { now });
    if (!result) {
        const { session, course } = await loadSession(sessionId);
        if (session.status === "ended") return { session, course, stats: session.stats, alreadyEnded: true };
        throw fail(409, "This class is no longer live", "SESSION_NOT_LIVE");
    }
    return { ...result, alreadyEnded: false };
};

// ── QR for the presenter ───────────────────────────────────────────────────

export const getSessionQr = async (user, sessionId, { now = new Date() } = {}) => {
    const { session, course } = await loadSession(sessionId, { lean: true });
    assertCanReportSession(user, session, course);
    if (session.status !== "live") throw fail(409, "Attendance for this class isn't open", "SESSION_NOT_LIVE");
    const { session: live } = await rotateIfExpired(session._id, now);
    if (!live) throw fail(409, "Attendance for this class isn't open", "SESSION_NOT_LIVE");
    return qrPayload(live);
};

// ── manual marking ─────────────────────────────────────────────────────────

export const planMark = async (user, sessionId, { studentId, status, note } = {}) => {
    const { session, course } = await loadSession(sessionId);
    assertCanManageSession(user, session, course);
    if (!["live", "ended"].includes(session.status)) {
        throw fail(409, session.status === "scheduled" ? "Start the class before marking attendance" : `This class is ${session.status}`, "SESSION_NOT_LIVE");
    }
    const value = String(status ?? "").trim().toLowerCase();
    if (!RECORD_STATUSES.includes(value)) throw validation(`status must be one of ${RECORD_STATUSES.join(", ")}`, "status");
    if (!isObjectId(String(studentId ?? "").trim())) throw validation("studentId must be a valid id", "studentId");
    const student = await User.findById(String(studentId).trim()).select(STUDENT_CARD_FIELDS).lean();
    if (!student) throw fail(404, "Student not found", "NOT_FOUND");
    const hasRecord = await AttendanceRecord.exists({ session: session._id, student: student._id });
    if (!isEnrolled(student, course) && !hasRecord) {
        throw fail(403, `${student.name || "This student"} is not enrolled in ${course.code}`, "NOT_ENROLLED");
    }
    const text = note === undefined ? undefined : optionalString(note, "note", 300);
    return { session, course, student, status: value, note: text };
};

/** POST /sessions/:id/records → {record, stats, session, course, student}. */
export const markRecord = async (user, sessionId, body = {}, { now = new Date() } = {}) => {
    const plan = await planMark(user, sessionId, body);
    const { session, course, student, status } = plan;
    const set = { status, method: "manual", markedAt: now, markedBy: user._id };
    const update = { $set: set, $setOnInsert: { course: course._id, flags: [] } };
    if (plan.note) set.note = plan.note;
    else if (plan.note === "") update.$unset = { note: "" };
    let previous = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            previous = await AttendanceRecord.findOneAndUpdate(
                { session: session._id, student: student._id },
                update,
                { upsert: true, returnDocument: "before" },
            ).lean();
            break;
        } catch (error) {
            if (error?.code !== 11000 || attempt === 1) throw error;
        }
    }
    const record = await AttendanceRecord.findOne({ session: session._id, student: student._id }).lean();
    const inc = {};
    if (!previous) inc[`stats.${status}`] = 1;
    else if (previous.status !== status) {
        inc[`stats.${previous.status}`] = -1;
        inc[`stats.${status}`] = 1;
    }
    const updated = Object.keys(inc).length
        ? await ClassSession.findOneAndUpdate({ _id: session._id }, { $inc: inc }, { returnDocument: "after" })
        : session;
    emitMarked(updated, record, student);
    if (!previous || previous.status !== status || plan.note) await notifyManualMark(record, updated, course);
    const stats = serializeSession(updated).stats;
    return { record: serializeRecord(record, { student }), stats, session: updated, course, student };
};

// ── lists ──────────────────────────────────────────────────────────────────

const parseStatusFilter = (value, now) => {
    if (value === undefined || value === null || value === "") return {};
    const list = String(value).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    const statuses = [];
    let missed = false;
    for (const entry of list) {
        if (entry === "missed") missed = true;
        else if (SESSION_STATUSES.includes(entry)) statuses.push(entry);
        else throw validation(`status must be one of ${[...SESSION_STATUSES, "missed"].join(", ")}`, "status");
    }
    if (missed && !statuses.length) return { status: "scheduled", endsAt: { $lt: now } };
    if (missed) return { $or: [{ status: { $in: statuses } }, { status: "scheduled", endsAt: { $lt: now } }] };
    return { status: statuses.length === 1 ? statuses[0] : { $in: statuses } };
};

const parseBound = (value, field, now, edge) => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = parseDateInput(value, { field, now, forward: false });
    if (parsed.hasTime) return parsed.date;
    return edge === "start" ? parsed.dayStart : parsed.dayEnd;
};

/** Scope filter for the caller's role: teacher → own, student → enrolled courses, tpo/admin → all. */
const roleScope = async (user) => {
    if (user.role === "teacher") return { teacher: user._id };
    if (user.role === "student") {
        const courseIds = await Course.find({ students: user._id }).distinct("_id");
        return { course: { $in: courseIds } };
    }
    if (isOversight(user)) return {};
    throw fail(403, "Attendance is available to teachers, students and the placement office", "FORBIDDEN");
};

const decorate = async (user, sessions, now) => {
    let records = new Map();
    if (user.role === "student" && sessions.length) {
        const rows = await AttendanceRecord.find({ student: user._id, session: { $in: sessions.map((session) => session._id) } })
            .select("session status method markedAt").lean();
        records = new Map(rows.map((row) => [String(row.session), row]));
    }
    return sessions.map((session) => {
        const out = serializeSession(session, { now, includeGeo: isOwner(user, { teacher: session.teacher }) });
        if (user.role === "student") {
            const mine = records.get(String(session._id));
            out.myRecord = mine ? mine.status : null;
            out.myRecordDetail = mine ? { status: mine.status, method: mine.method, markedAt: mine.markedAt } : null;
        }
        return out;
    });
};

/** GET /sessions → {sessions, from, to}. Default window: today −1 day … +14 days (college TZ). */
export const listSessions = async (user, query = {}, { now = new Date() } = {}) => {
    const today = toLocal(now).startOf("day");
    const from = parseBound(query.from, "from", now, "start") || today.minus({ days: 1 }).toJSDate();
    const to = parseBound(query.to, "to", now, "end") || today.plus({ days: 14 }).endOf("day").toJSDate();
    if (to < from) throw validation("to must be after from", "to");
    const filter = { ...(await roleScope(user)), startsAt: { $gte: from, $lte: to }, ...parseStatusFilter(query.status, now) };
    const courseId = query.courseId ?? query.course;
    if (courseId) {
        if (!isObjectId(String(courseId))) throw validation("courseId must be a valid id", "courseId");
        const scoped = filter.course;
        filter.course = toObjectId(courseId);
        if (scoped && !scoped.$in.some((id) => String(id) === String(courseId))) filter.course = { $in: [] };
    }
    const limit = intParam(query.limit, { min: 1, max: 500, fallback: 300 });
    const sessions = await ClassSession.find(filter)
        .populate("course", "code name room")
        .populate("teacher", "name email")
        .sort({ startsAt: 1 })
        .limit(limit)
        .lean();
    return { sessions: await decorate(user, sessions, now), from, to };
};

/** GET /me/schedule → {sessions, from, to}: classes not yet over, starting within `days` days. */
export const mySchedule = async (user, { days } = {}, { now = new Date() } = {}) => {
    const span = intParam(days, { min: 1, max: 31, fallback: 7 });
    const to = toLocal(now).plus({ days: span }).endOf("day").toJSDate();
    const filter = { ...(await roleScope(user)), endsAt: { $gt: now }, startsAt: { $lte: to } };
    const sessions = await ClassSession.find(filter)
        .populate("course", "code name room")
        .populate("teacher", "name email")
        .sort({ startsAt: 1 })
        .limit(500)
        .lean();
    return { sessions: await decorate(user, sessions, now), from: now, to, days: span };
};

// ── detail + export ────────────────────────────────────────────────────────

const rosterOf = async (session, course) => {
    const records = await AttendanceRecord.find({ session: session._id }).lean();
    const ids = new Set([...(course.students || []).map(String), ...records.map((record) => String(record.student))]);
    const students = await User.find({ _id: { $in: [...ids].map(toObjectId) } }).select(STUDENT_CARD_FIELDS).lean();
    const byStudent = new Map(records.map((record) => [String(record.student), record]));
    const enrolled = new Set((course.students || []).map(String));
    return students
        .map((student) => ({
            student: userCard(student),
            record: byStudent.has(String(student._id)) ? serializeRecord(byStudent.get(String(student._id)), { student }) : null,
            enrolled: enrolled.has(String(student._id)),
        }))
        .sort((a, b) => (a.student.rollNumber || a.student.ggsipuEnrollment || a.student.name || "")
            .localeCompare(b.student.rollNumber || b.student.ggsipuEnrollment || b.student.name || "", undefined, { numeric: true }));
};

/** GET /sessions/:id — teacher/tpo: {session, course, roster, stats}; enrolled student: {session, course, myRecord}. */
export const getSessionDetail = async (user, sessionId, { now = new Date() } = {}) => {
    const { session, course } = await loadSession(sessionId, { lean: true });
    const populated = await Course.findById(course._id).populate("teacher", "name email").lean();
    if (sameId(session.teacher, user._id) || isOwner(user, course) || isOversight(user)) {
        const roster = await rosterOf(session, course);
        const serialized = serializeSession(session, { now, course, includeGeo: true });
        return { session: serialized, course: serializeCourse(populated, { manage: true }), roster, stats: serialized.stats };
    }
    if (user.role === "student" && isEnrolled(user, course)) {
        const record = await AttendanceRecord.findOne({ session: session._id, student: user._id }).lean();
        return {
            session: serializeSession(session, { now, course }),
            course: serializeCourse(populated, { manage: false }),
            myRecord: record ? serializeRecord(record, { student: user }) : null,
        };
    }
    throw fail(403, "You don't have access to this class", "FORBIDDEN");
};

const csvCell = (value) => {
    let text = value === null || value === undefined ? "" : String(value);
    // Neutralise spreadsheet formulas (CSV injection).
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** GET /sessions/:id/export.csv → {filename, csv}. */
export const exportSessionCsv = async (user, sessionId) => {
    const { session, course } = await loadSession(sessionId, { lean: true });
    assertCanReportSession(user, session, course);
    const roster = await rosterOf(session, course);
    const header = ["Roll/Enrollment", "Name", "Email", "Status", "Method", `Marked At (${zone()})`];
    const rows = roster.map(({ student, record }) => [
        student.ggsipuEnrollment || student.rollNumber || "",
        student.name || "",
        student.email || "",
        record ? record.status : "not marked",
        record ? record.method : "",
        record?.markedAt ? formatDateTime(record.markedAt) : "",
    ]);
    const csv = `﻿${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
    const safeCode = String(course.code || "class").replace(/[^A-Za-z0-9_-]+/g, "-");
    return { filename: `attendance-${safeCode}-${formatDate(session.startsAt)}.csv`, csv };
};

// ── timetable materialisation ──────────────────────────────────────────────

/**
 * Create `source:"timetable"` sessions for the next `days` days of a course's
 * timetable. Idempotent: a slot already holding a session (any status, also a
 * cancelled one or one moved away from this slot) is skipped.
 * @returns {Promise<object[]>} the created sessions (lean)
 */
export const materialiseCourse = async (course, { days, now = new Date() } = {}) => {
    if (course.status !== "active" || !course.timetable?.length) return [];
    const horizon = Math.min(60, Math.max(1, Number(days) || course.settings?.autoGenerateDays || DEFAULT_SETTINGS.autoGenerateDays));
    const today = toLocal(now).startOf("day");
    const createdIds = [];
    for (let offset = 0; offset < horizon; offset += 1) {
        const day = today.plus({ days: offset });
        const weekday = contractWeekday(day);
        for (const slot of course.timetable) {
            if (slot.day !== weekday) continue;
            const clock = parseHHmm(slot.start);
            if (!clock) continue;
            const start = day.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
            const startsAt = start.toJSDate();
            if (startsAt <= now) continue;
            const endsAt = start.plus({ minutes: slot.durationMinutes || DEFAULT_DURATION_MINUTES }).toJSDate();
            try {
                const result = await ClassSession.updateOne(
                    { course: course._id, $or: [{ startsAt }, { slotStartsAt: startsAt }] },
                    {
                        $setOnInsert: {
                            course: course._id,
                            teacher: course.teacher,
                            topic: "",
                            room: slot.room || course.room || undefined,
                            mode: "offline",
                            startsAt,
                            endsAt,
                            slotStartsAt: startsAt,
                            status: "scheduled",
                            source: "timetable",
                            stats: { present: 0, late: 0, absent: 0, excused: 0, enrolled: (course.students || []).length },
                        },
                    },
                    { upsert: true },
                );
                if (result.upsertedId) createdIds.push(result.upsertedId);
            } catch (error) {
                if (error?.code !== 11000) throw error; // a concurrent run created it
            }
        }
    }
    if (!createdIds.length) return [];
    return ClassSession.find({ _id: { $in: createdIds } }).sort({ startsAt: 1 }).lean();
};

/** Drop future, never-moved timetable sessions that no longer match the course's timetable. */
export const pruneStaleTimetableSessions = async (course, { now = new Date() } = {}) => {
    const candidates = await ClassSession.find({
        course: course._id, source: "timetable", status: "scheduled", startsAt: { $gt: now },
    }).select("startsAt endsAt slotStartsAt").lean();
    const stale = candidates.filter((session) => {
        if (session.slotStartsAt && session.slotStartsAt.getTime() !== session.startsAt.getTime()) return false; // moved by hand
        const local = toLocal(session.startsAt);
        const minutes = Math.round((session.endsAt - session.startsAt) / 60_000);
        return !(course.timetable || []).some((slot) => slot.day === contractWeekday(local)
            && slot.start === local.toFormat("HH:mm")
            && (slot.durationMinutes || DEFAULT_DURATION_MINUTES) === minutes);
    });
    if (!stale.length) return 0;
    const { deletedCount } = await ClassSession.deleteMany({ _id: { $in: stale.map((session) => session._id) }, status: "scheduled" });
    return deletedCount;
};

const sendDigests = async (createdByCourse, { notifyTeachers }) => {
    const perStudent = new Map();
    const perTeacher = new Map();
    for (const { course, sessions } of createdByCourse) {
        for (const studentId of (course.students || []).map(String)) {
            if (!perStudent.has(studentId)) perStudent.set(studentId, []);
            perStudent.get(studentId).push({ course, sessions });
        }
        const teacherId = String(course.teacher);
        if (!perTeacher.has(teacherId)) perTeacher.set(teacherId, []);
        perTeacher.get(teacherId).push({ course, sessions });
    }
    const describe = (entries) => {
        const total = entries.reduce((sum, entry) => sum + entry.sessions.length, 0);
        const first = entries.flatMap((entry) => entry.sessions.map((session) => ({ session, course: entry.course })))
            .sort((a, b) => a.session.startsAt - b.session.startsAt)[0];
        const title = entries.length === 1
            ? `${total} class${total === 1 ? "" : "es"} scheduled for ${entries[0].course.code}`
            : `${total} classes scheduled: ${entries.map((entry) => `${entry.course.code} ×${entry.sessions.length}`).join(", ")}`;
        const body = `Next: ${first.course.code} · ${formatSlot(first.session.startsAt, first.session.endsAt)}`;
        const key = `timetable:${entries.flatMap((entry) => entry.sessions.map((session) => String(session._id))).sort()[0]}`;
        return { total, title, body, key, firstSession: first.session };
    };
    let created = 0;
    for (const [studentId, entries] of perStudent) {
        const text = describe(entries);
        const result = await safeNotify(studentId, {
            type: "attendance.scheduled",
            title: text.title,
            body: text.body,
            ui: studentScheduleUi(),
            data: { courseIds: entries.map((entry) => idString(entry.course._id)), count: text.total },
            priority: "low",
            dedupeKey: text.key,
        });
        created += result.created;
    }
    if (notifyTeachers) {
        for (const [teacherId, entries] of perTeacher) {
            const text = describe(entries);
            const result = await safeNotify(teacherId, {
                type: "attendance.scheduled",
                title: `Timetable: ${text.title}`,
                body: text.body,
                ui: teacherScheduleUi(entries.length === 1 ? { courseId: idString(entries[0].course._id) } : {}),
                data: { courseIds: entries.map((entry) => idString(entry.course._id)), count: text.total },
                priority: "low",
                push: false,
                dedupeKey: text.key,
            });
            created += result.created;
        }
    }
    return created;
};

/** POST /courses/:id/generate → {created, sessions}. */
export const generateForCourse = async (user, courseId, { days } = {}, { now = new Date() } = {}) => {
    const course = await loadCourse(courseId, { lean: true });
    assertCanManageCourse(user, course);
    assertActiveCourse(course);
    if (!course.timetable?.length) throw validation("Add weekly timetable slots before generating sessions", "timetable");
    if (days !== undefined && days !== null && days !== "") {
        const value = Number(days);
        if (!Number.isInteger(value) || value < 1 || value > 60) throw validation("days must be 1-60", "days");
    }
    const sessions = await materialiseCourse(course, { days, now });
    if (sessions.length) await sendDigests([{ course, sessions }], { notifyTeachers: false });
    return { created: sessions.length, sessions: sessions.map((session) => serializeSession(session, { now, course })) };
};

/**
 * After a course's timetable changed: drop future timetable sessions that no
 * longer match, then materialise the new slots (one digest per student).
 */
export const refreshTimetable = async (course, { now = new Date() } = {}) => {
    const removed = await pruneStaleTimetableSessions(course, { now });
    const sessions = await materialiseCourse(course, { now });
    if (sessions.length) await sendDigests([{ course, sessions }], { notifyTeachers: false });
    return { removed, created: sessions.length };
};

/** Background job + boot: materialise every active course with a timetable. */
export const materialiseAllTimetables = async ({ now = new Date() } = {}) => {
    const courses = await Course.find({ status: "active", "timetable.0": { $exists: true } }).lean();
    const createdByCourse = [];
    for (const course of courses) {
        try {
            const sessions = await materialiseCourse(course, { now });
            if (sessions.length) createdByCourse.push({ course, sessions });
        } catch (error) {
            console.error(`[attendance] timetable materialisation failed for course ${course._id}:`, error?.message || error);
        }
    }
    if (createdByCourse.length) await sendDigests(createdByCourse, { notifyTeachers: true });
    return { courses: courses.length, created: createdByCourse.reduce((sum, entry) => sum + entry.sessions.length, 0) };
};
