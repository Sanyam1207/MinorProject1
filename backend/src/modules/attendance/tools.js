// Copilot tools of the attendance module (AGENT-TOOLS.md §2/§5, UI-ACTIONS.md §10).
// Every tool reuses the services the REST API uses; previews resolve fuzzy
// references and dates WITHOUT side effects and return the resolved args
// (ids + ISO times) so the confirmed run executes exactly what was shown.
import { fail } from "../../core/http.js";
import { isOversight } from "./access.js";
import { RECORD_STATUSES } from "./config.js";
import {
    buildCourseReport,
    createCourse,
    findAutoEnrollStudents,
    joinCourse,
    listCourses,
    normaliseCourseInput,
    notifyDefaulters,
} from "./courses.service.js";
import { AttendanceRecord, ClassSession, Course } from "./models/index.js";
import { AmbiguousReference, courseLabel, resolveCourse, resolveSession, resolveStudent, sessionLabel, studentLabel } from "./resolve.js";
import { idString, serializeCourse, serializeSession } from "./serializers.js";
import {
    autoScheduleSession,
    cancelSession,
    createSession,
    endSession,
    getSessionDetail,
    listSessions,
    markRecord,
    mySchedule,
    planAutoSession,
    planCancel,
    planEnd,
    planMark,
    planSession,
    planStart,
    planUpdate,
    refreshTimetable,
    startSession,
    updateSession,
} from "./sessions.service.js";
import { mySummary } from "./student.service.js";
import { formatDay, formatSlot, formatTime, parseWindow } from "./time.js";

const TEACHER = ["teacher"];
const STAFF = ["teacher", "tpo", "admin"];
const EVERYONE = ["teacher", "student", "tpo", "admin"];

const nowOf = (ctx) => (ctx?.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date());
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const list = (items, max = 8) => (items.length > max ? `${items.slice(0, max).join("; ")}; …and ${items.length - max} more` : items.join("; "));

/** Turn AmbiguousReference into the registry's `{ambiguous:true}` answer. */
const guard = (fn) => async (args, ctx) => {
    try {
        return await fn(args ?? {}, ctx);
    } catch (error) {
        if (error instanceof AmbiguousReference) return { ambiguous: true, message: error.message, candidates: error.candidates };
        throw error;
    }
};

const requireUser = (ctx) => {
    if (!ctx?.user?._id) throw fail(401, "Sign in to use attendance tools", "UNAUTHORIZED");
    return ctx.user;
};

const isStaffView = (ctx) => isOversight(ctx.user) || ctx.role === "tpo" || ctx.role === "admin";

const sessionLine = (session) => {
    const course = session.course?.code ? `${session.course.code} ` : "";
    const where = session.mode === "online" ? " · online" : session.room ? ` · ${session.room}` : "";
    const flag = session.status === "cancelled" ? " (cancelled)"
        : session.status === "live" ? " (LIVE)"
            : session.isMissed ? " (missed)"
                : session.status === "ended" ? " (ended)" : "";
    return `${course}${formatSlot(session.startsAt, session.endsAt)}${where}${flag}`;
};

const statsLine = (stats) => `${stats.present ?? 0} present, ${stats.late ?? 0} late, ${stats.absent ?? 0} absent, ${stats.excused ?? 0} excused of ${stats.enrolled ?? 0}`;

// ── parameter fragments ────────────────────────────────────────────────────
const COURSE_PARAM = { type: "string", description: "Course id, code or name, e.g. 'CS301' or 'dbms'" };
const SESSION_PARAM = { type: "string", description: "Class session id, or a description like 'dbms tomorrow 10am'. Optional when course/date identify it." };
const DURATION_PARAM = { type: "integer", minimum: 15, maximum: 300, description: "Length in minutes (default 60)" };

// ── tools ──────────────────────────────────────────────────────────────────

const listCoursesTool = {
    name: "attendance_list_courses",
    description: "List attendance courses. Teachers get their own courses (join code, student count, next class); students get "
        + "their enrolled courses with attendance percentage; the placement office gets every course.",
    roles: EVERYONE,
    confirm: false,
    parameters: {
        type: "object",
        properties: { includeArchived: { type: "boolean", description: "Also list archived courses" } },
    },
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const courses = await listCourses(user, { status: args.includeArchived ? "all" : undefined, now: nowOf(ctx) });
        let lines;
        if (user.role === "student") {
            lines = courses.map((course) => `${course.code} ${course.name}: ${course.summary.percent === null
                ? "no classes held yet"
                : `${course.summary.percent}% (${course.summary.attended}/${course.summary.held}, ${course.summary.status})`}`);
        } else {
            lines = courses.map((course) => `${course.code} ${course.name}${course.section ? ` (sec ${course.section})` : ""}: ${plural(course.studentCount, "student")}`
                + `${user.role === "teacher" && course.joinCode ? `, join code ${course.joinCode}` : ""}`
                + `${course.nextSession ? `, next ${formatDay(course.nextSession.startsAt)} ${formatTime(course.nextSession.startsAt)}` : ""}`
                + `${course.status === "archived" ? " [archived]" : ""}`);
        }
        const summary = courses.length
            ? `${plural(courses.length, "course")}: ${list(lines)}.`
            : user.role === "student" ? "You're not enrolled in any course yet. Ask your teacher for a join code." : "No courses yet.";
        const ui = user.role === "student" ? { panel: "attendance.student" }
            : user.role === "teacher" ? { panel: "teacher.courses" }
                : { panel: "tpo.attendance" };
        return { summary, data: { courses }, ui };
    }),
};

const TIMETABLE_PARAM = {
    type: "array",
    description: "Weekly slots, e.g. [{day:'mon', start:'10:00', durationMinutes:60, room:'LT-2'}]",
    items: {
        type: "object",
        properties: {
            day: { type: "string", description: "Weekday name or 0-6 (0 = Sunday)" },
            start: { type: "string", description: "Start time HH:mm (24h)" },
            durationMinutes: { type: "integer", minimum: 15, maximum: 300 },
            room: { type: "string" },
        },
        required: ["day", "start"],
    },
};

const courseBodyFromArgs = (args) => compact({
    code: args.code,
    name: args.name,
    branch: args.branch,
    semester: args.semester,
    section: args.section,
    passingYear: args.passingYear,
    academicYear: args.academicYear,
    room: args.room,
    timetable: args.timetable,
    settings: args.minAttendancePercent !== undefined ? { minAttendancePercent: args.minAttendancePercent } : undefined,
});

const describeTimetable = (timetable) => timetable
    .map((slot) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][slot.day]} ${slot.start} (${slot.durationMinutes} min${slot.room ? `, ${slot.room}` : ""})`)
    .join(", ");

const createCourseTool = {
    name: "attendance_create_course",
    description: "Create a course for the teacher (code + name, optional branch/section/semester, weekly timetable and "
        + "auto-enrolment of matching students). Students can then join with the generated join code.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            code: { type: "string", description: "Course code, e.g. CS301" },
            name: { type: "string", description: "Course name, e.g. Database Management Systems" },
            branch: { type: "string", description: "Branch/department of the students, e.g. CSE (needed for auto-enrol)" },
            semester: { type: "integer", minimum: 1, maximum: 12 },
            section: { type: "string", description: "Section, e.g. A" },
            passingYear: { type: "string", description: "Graduation year of the batch, e.g. 2027" },
            academicYear: { type: "string", description: "e.g. 2026-27" },
            room: { type: "string", description: "Default room" },
            timetable: TIMETABLE_PARAM,
            autoEnroll: { type: "boolean", description: "Enrol every student matching branch/section/passing year now" },
            minAttendancePercent: { type: "number", minimum: 0, maximum: 100, description: "Required attendance % (default 75)" },
        },
        required: ["code", "name"],
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const fields = normaliseCourseInput(courseBodyFromArgs(args));
        const clash = await Course.exists({
            teacher: user._id, status: "active", code: fields.code, section: fields.section ?? null, academicYear: fields.academicYear ?? null,
        });
        if (clash) throw fail(409, `You already have an active course ${fields.code}${fields.section ? ` (section ${fields.section})` : ""}`, "DUPLICATE");
        let enrolNote = "";
        if (args.autoEnroll) {
            if (!fields.branch) throw fail(400, "Give the branch (e.g. CSE) to auto-enrol students", "VALIDATION", { field: "branch" });
            const matches = await findAutoEnrollStudents(fields);
            enrolNote = ` and auto-enrol ${plural(matches.length, "matching student")}`;
        }
        const details = [fields.branch && `branch ${fields.branch}`, fields.section && `section ${fields.section}`, fields.semester && `semester ${fields.semester}`]
            .filter(Boolean).join(", ");
        const timetable = fields.timetable?.length ? `, timetable ${describeTimetable(fields.timetable)}` : "";
        return {
            summary: `Create course ${fields.code} · ${fields.name}${details ? ` (${details})` : ""}${timetable}${enrolNote}?`,
            args: compact({
                ...args,
                code: fields.code,
                name: fields.name,
                timetable: fields.timetable?.length ? fields.timetable.map((slot) => ({ ...slot, day: String(slot.day) })) : undefined,
            }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { course, added } = await createCourse(user, { ...courseBodyFromArgs(args), autoEnroll: args.autoEnroll === true });
        const generated = course.timetable?.length ? await refreshTimetable(course.toObject(), { now: nowOf(ctx) }) : { created: 0 };
        const parts = [`Created ${course.code} · ${course.name}. Join code ${course.joinCode}.`];
        if (args.autoEnroll) parts.push(`${plural(added, "student")} auto-enrolled.`);
        if (generated.created) parts.push(`${plural(generated.created, "class", "classes")} generated from the timetable.`);
        return {
            summary: parts.join(" "),
            data: { course: serializeCourse(course, { manage: true }), added, generated: generated.created },
            ui: { panel: "teacher.courses", params: { courseId: idString(course._id) } },
        };
    }),
};

const listSessionsTool = {
    name: "attendance_list_sessions",
    description: "List class sessions (teacher: own classes; student: classes of enrolled courses; placement office: all) "
        + "in a date range, optionally for one course or status. Default range: yesterday to two weeks ahead.",
    roles: EVERYONE,
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            course: COURSE_PARAM,
            from: { type: "string", description: "Start of the range: date, ISO or phrase like 'today', 'this week', 'next 3 days'" },
            to: { type: "string", description: "End of the range (date or ISO)" },
            status: { type: "string", enum: ["scheduled", "live", "ended", "cancelled", "missed"] },
        },
    },
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const now = nowOf(ctx);
        const course = args.course ? await resolveCourse(args.course, ctx, { includeArchived: true }) : null;
        let from = args.from;
        let to = args.to;
        if (from && !to) {
            const window = parseWindow(from, { now });
            if (window) {
                from = window.from.toISOString();
                to = window.to.toISOString();
            }
        }
        const { sessions } = await listSessions(user, compact({ from, to, courseId: course ? idString(course._id) : undefined, status: args.status }), { now });
        const summary = sessions.length
            ? `${plural(sessions.length, "class", "classes")}: ${list(sessions.map(sessionLine))}.`
            : `No classes found${course ? ` for ${course.code}` : ""} in that range.`;
        const params = compact({ courseId: course ? idString(course._id) : undefined });
        let ui;
        if (user.role === "student") ui = { panel: "schedule" };
        else if (user.role === "teacher") ui = { panel: "teacher.schedule", params };
        else ui = { panel: "tpo.attendance", params };
        return { summary, data: { sessions }, ui };
    }),
};

const scheduleTool = {
    name: "attendance_schedule_class",
    description: "Schedule a class for one of the teacher's courses at a given time. Enrolled students are notified. "
        + "Rejects times that overlap the teacher's or the course's other classes.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            course: COURSE_PARAM,
            when: { type: "string", description: "Start time, natural language or ISO, e.g. 'tomorrow 10am'" },
            durationMinutes: DURATION_PARAM,
            room: { type: "string" },
            topic: { type: "string" },
            mode: { type: "string", enum: ["offline", "online"] },
        },
        required: ["course", "when"],
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const course = await resolveCourse(args.course, ctx);
        const plan = await planSession(user, course, args, { now: nowOf(ctx) });
        const where = plan.mode === "online" ? " online" : plan.room ? ` in ${plan.room}` : "";
        return {
            summary: `Schedule ${course.code} · ${course.name} on ${formatSlot(plan.startsAt, plan.endsAt)}${where}${plan.topic ? ` (topic: ${plan.topic})` : ""}? `
                + `${plural((course.students || []).length, "student")} will be notified.`,
            args: compact({
                course: idString(course._id),
                when: plan.startsAt.toISOString(),
                durationMinutes: plan.durationMinutes,
                room: args.room,
                topic: args.topic,
                mode: args.mode,
            }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const course = await resolveCourse(args.course, ctx);
        const { session, notified } = await createSession(user, { ...args, courseId: idString(course._id) }, { source: "ai", now: nowOf(ctx) });
        const serialized = serializeSession(session, { course });
        return {
            summary: `Scheduled ${course.code} for ${formatSlot(session.startsAt, session.endsAt)}${session.room ? ` (${session.room})` : ""}. ${plural(notified, "student")} notified.`,
            data: { session: serialized },
            ui: { panel: "teacher.schedule", params: { sessionId: serialized._id } },
        };
    }),
};

const autoWindow = (args, now) => {
    if (!args.within) return {};
    const window = parseWindow(args.within, { now });
    if (!window) throw fail(400, `Could not understand "${args.within}". Try "this week", "next 3 days" or "by friday".`, "VALIDATION", { field: "within" });
    return { earliest: window.from.toISOString(), latest: window.to.toISOString(), label: window.label };
};

const autoScheduleTool = {
    name: "attendance_auto_schedule_class",
    description: "Find the earliest free slot for an extra class of a course (working hours, 15-minute grid) that avoids "
        + "the teacher's classes, the course's classes and classes of other courses sharing students, then schedule it.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            course: COURSE_PARAM,
            durationMinutes: DURATION_PARAM,
            within: { type: "string", description: "Search window, e.g. 'this week', 'next 3 days', 'tomorrow', 'by friday' (default: next 7 days)" },
            preferredDays: { type: "array", items: { type: "string" }, description: "Allowed weekdays, e.g. ['mon','wed'] (0 = Sunday)" },
            preferredStart: { type: "string", description: "Earliest start of day HH:mm" },
            preferredEnd: { type: "string", description: "Latest end of day HH:mm" },
            topic: { type: "string" },
            room: { type: "string" },
        },
        required: ["course"],
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const now = nowOf(ctx);
        const course = await resolveCourse(args.course, ctx);
        const window = autoWindow(args, now);
        const { slot, reason } = await planAutoSession(user, course, { ...args, ...window }, { now });
        return {
            summary: `Schedule ${course.code} in the earliest free slot: ${formatSlot(slot.startsAt, slot.endsAt)}? ${reason} `
                + `${plural((course.students || []).length, "student")} will be notified.`,
            args: compact({ ...args, course: idString(course._id) }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const now = nowOf(ctx);
        const course = await resolveCourse(args.course, ctx);
        const window = autoWindow(args, now);
        const { session, reason, notified } = await autoScheduleSession(user, compact({
            courseId: idString(course._id),
            durationMinutes: args.durationMinutes,
            earliest: window.earliest,
            latest: window.latest,
            preferredDays: args.preferredDays,
            preferredStart: args.preferredStart,
            preferredEnd: args.preferredEnd,
            topic: args.topic,
            room: args.room,
        }), { source: "auto", now });
        const serialized = serializeSession(session, { course });
        return {
            summary: `Scheduled ${course.code} for ${formatSlot(session.startsAt, session.endsAt)}. ${plural(notified, "student")} notified. ${reason}`,
            data: { session: serialized, reason },
            ui: { panel: "teacher.schedule", params: { sessionId: serialized._id } },
        };
    }),
};

const rescheduleTool = {
    name: "attendance_reschedule_class",
    description: "Move a scheduled class to a new time (students are notified). Identify the class by session id, or by "
        + "course and its current time in `from` (e.g. course 'dbms', from 'tomorrow 10am', when '2pm').",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            session: SESSION_PARAM,
            course: COURSE_PARAM,
            from: { type: "string", description: "Current date/time of the class to move, e.g. 'tomorrow 10am'" },
            when: { type: "string", description: "New start time, e.g. 'friday 2pm' (a bare time keeps the same day)" },
            durationMinutes: DURATION_PARAM,
            room: { type: "string" },
        },
        required: ["when"],
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session, course } = await resolveSession(args, ctx, { statuses: ["scheduled"], order: "next", dateField: "from" });
        const plan = await planUpdate(user, session._id, compact({ when: args.when, durationMinutes: args.durationMinutes, room: args.room }), { now: nowOf(ctx) });
        const startsAt = plan.set.startsAt || session.startsAt;
        const endsAt = plan.set.endsAt || session.endsAt;
        return {
            summary: `Move ${course.code} from ${formatSlot(session.startsAt, session.endsAt)} to ${formatSlot(startsAt, endsAt)}${plan.set.room ? ` in ${plan.set.room}` : ""}? `
                + `${plural((course.students || []).length, "student")} will be notified.`,
            args: compact({
                session: idString(session._id),
                when: startsAt.toISOString(),
                durationMinutes: Math.round((endsAt - startsAt) / 60_000),
                room: args.room,
            }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session: original, course } = await resolveSession(args, ctx, { statuses: ["scheduled"], order: "next", dateField: "from" });
        const { session, changed } = await updateSession(user, original._id, compact({ when: args.when, durationMinutes: args.durationMinutes, room: args.room }), { now: nowOf(ctx) });
        const serialized = serializeSession(session, { course });
        return {
            summary: changed
                ? `Moved ${course.code} from ${formatSlot(original.startsAt, original.endsAt)} to ${formatSlot(session.startsAt, session.endsAt)}. Students were notified.`
                : `${course.code} is already at ${formatSlot(session.startsAt, session.endsAt)}; nothing changed.`,
            data: { session: serialized },
            ui: { panel: "teacher.schedule", params: { sessionId: serialized._id } },
        };
    }),
};

const cancelTool = {
    name: "attendance_cancel_class",
    description: "Cancel a scheduled (or live) class and notify its students. Identify it by session id or by course and date/time.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            session: SESSION_PARAM,
            course: COURSE_PARAM,
            when: { type: "string", description: "Date/time of the class, e.g. 'tomorrow' or 'friday 10am'" },
            reason: { type: "string", description: "Shown to students" },
        },
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session, course } = await resolveSession(args, ctx, { statuses: ["scheduled", "live"], order: "next", liveFirst: true });
        const plan = await planCancel(user, session._id, { reason: args.reason });
        return {
            summary: `Cancel ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}${plan.reason ? ` (reason: ${plan.reason})` : ""}? `
                + `${plural((course.students || []).length, "student")} will be notified.`,
            args: compact({ session: idString(session._id), reason: args.reason }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session: target, course } = await resolveSession(args, ctx, { statuses: ["scheduled", "live"], order: "next", liveFirst: true });
        const { session } = await cancelSession(user, target._id, { reason: args.reason }, { now: nowOf(ctx) });
        const serialized = serializeSession(session, { course });
        return {
            summary: `Cancelled ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}. Students were notified.`,
            data: { session: serialized },
            ui: { panel: "teacher.schedule", params: { courseId: idString(course._id) } },
        };
    }),
};

const startTool = {
    name: "attendance_start_session",
    description: "Open attendance for a class: it goes live, students are notified and a rotating single-use QR code "
        + "appears on the live panel for students to scan. Defaults to the teacher's current/next class.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: { session: SESSION_PARAM, course: COURSE_PARAM },
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session, course } = await resolveSession(args, ctx, { statuses: ["live", "scheduled"], order: "next", liveFirst: true });
        const plan = await planStart(user, session._id, { now: nowOf(ctx) });
        const geo = course.settings?.requireGeo && !plan.alreadyLive
            ? " This course checks location, so you'll press START on the live panel to share it."
            : "";
        return {
            summary: plan.alreadyLive
                ? `${course.code} · ${formatSlot(session.startsAt, session.endsAt)} is already live. Open its QR code?`
                : `Start attendance for ${course.code} · ${formatSlot(session.startsAt, session.endsAt)} and show the QR code? `
                    + `${plural((course.students || []).length, "student")} will be notified.${geo}`,
            args: { session: idString(session._id) },
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session: target, course } = await resolveSession(args, ctx, { statuses: ["live", "scheduled"], order: "next", liveFirst: true });
        const ui = { panel: "teacher.live", params: { sessionId: idString(target._id) } };
        if (target.status === "scheduled" && course.settings?.requireGeo) {
            await planStart(user, target._id, { now: nowOf(ctx) });
            return {
                summary: `${course.code} checks students' location: press START on the live panel so your phone can share the classroom location.`,
                data: { session: serializeSession(target, { course }), needsLocation: true },
                ui,
            };
        }
        const { session, qr, alreadyLive } = await startSession(user, target._id, {}, { now: nowOf(ctx) });
        const serialized = serializeSession(session, { course });
        return {
            summary: alreadyLive
                ? `${course.code} is already live — the QR code is on the live panel.`
                : `Attendance is open for ${course.code}. The QR code is on the live panel; it changes after every scan and every ${qr.rotationSeconds} s.`,
            // The token itself stays out of the copilot's data: the live panel fetches it.
            data: { session: serialized, qr: { version: qr.version, expiresAt: qr.expiresAt, rotationSeconds: qr.rotationSeconds } },
            ui,
        };
    }),
};

const endTool = {
    name: "attendance_end_session",
    description: "End a live class: unmarked students become absent, statistics are final and students below the "
        + "attendance threshold are notified. Defaults to the teacher's live class.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: { session: SESSION_PARAM, course: COURSE_PARAM },
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session, course } = await resolveSession(args, ctx, { statuses: ["live"], order: "recent", describe: "live class" });
        await planEnd(user, session._id);
        const stats = session.stats || {};
        const marked = (stats.present ?? 0) + (stats.late ?? 0) + (stats.excused ?? 0) + (stats.absent ?? 0);
        const enrolled = (course.students || []).length;
        return {
            summary: `End attendance for ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}? ${marked} of ${enrolled} marked so far; `
                + `${plural(Math.max(0, enrolled - marked), "other student")} will be marked absent.`,
            args: { session: idString(session._id) },
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session: target, course } = await resolveSession(args, ctx, { statuses: ["live", "ended"], order: "recent", liveFirst: true, describe: "live class" });
        const { session } = await endSession(user, target._id, { now: nowOf(ctx) });
        const serialized = serializeSession(session, { course });
        const { stats } = serialized;
        const countable = stats.present + stats.late + stats.absent;
        const percent = countable ? Math.round(((stats.present + stats.late) / countable) * 1000) / 10 : null;
        return {
            summary: `Ended ${course.code}: ${statsLine(stats)}${percent === null ? "" : ` (${percent}% attendance)`}.`,
            data: { session: serialized, stats },
            ui: { panel: "teacher.report", params: { sessionId: serialized._id } },
        };
    }),
};

const sessionReportTool = {
    name: "attendance_session_report",
    description: "Attendance report of one class: counts plus who was absent or late. Defaults to the most recent class; "
        + "narrow it with a course and/or date.",
    roles: STAFF,
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            session: SESSION_PARAM,
            course: COURSE_PARAM,
            date: { type: "string", description: "Day or time of the class, e.g. 'yesterday' or 'monday 10am'" },
        },
    },
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session } = await resolveSession(args, ctx, {
            statuses: ["live", "ended"], order: "recent", liveFirst: true, dateField: "date", access: "report", forward: false,
        });
        const detail = await getSessionDetail(user, session._id, { now: nowOf(ctx) });
        const byStatus = (status) => detail.roster.filter((row) => (row.record?.status ?? "not marked") === status).map((row) => row.student.name);
        const absent = byStatus("absent");
        const late = byStatus("late");
        const unmarked = byStatus("not marked");
        const parts = [`${detail.course.code} · ${formatSlot(detail.session.startsAt, detail.session.endsAt)} (${detail.session.status}): ${statsLine(detail.stats)}.`];
        if (absent.length) parts.push(`Absent: ${list(absent, 15)}.`);
        if (late.length) parts.push(`Late: ${list(late, 15)}.`);
        if (detail.session.status === "live" && unmarked.length) parts.push(`Not marked yet: ${plural(unmarked.length, "student")}.`);
        const ui = isStaffView(ctx)
            ? { panel: "tpo.attendance", params: { sessionId: detail.session._id } }
            : { panel: "teacher.report", params: { sessionId: detail.session._id } };
        return {
            summary: parts.join(" "),
            data: {
                session: detail.session,
                stats: detail.stats,
                roster: detail.roster.map((row) => ({
                    student: { _id: row.student._id, name: row.student.name, email: row.student.email, ggsipuEnrollment: row.student.ggsipuEnrollment },
                    status: row.record?.status ?? null,
                    method: row.record?.method ?? null,
                    markedAt: row.record?.markedAt ?? null,
                })),
            },
            ui,
        };
    }),
};

const courseReportTool = {
    name: "attendance_course_report",
    description: "Attendance analytics of a course: classes held and every student's percentage, with the defaulters "
        + "below the threshold (default: the course's minimum) and how many classes each needs to recover.",
    roles: STAFF,
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            course: COURSE_PARAM,
            threshold: { type: "number", minimum: 0, maximum: 100, description: "Attendance % threshold (default: course minimum, usually 75)" },
        },
        required: ["course"],
    },
    handler: guard(async (args, ctx) => {
        requireUser(ctx);
        const course = await resolveCourse(args.course, ctx, { includeArchived: true });
        const report = await buildCourseReport(course, { threshold: args.threshold });
        const defaulters = report.defaulters.map((row) => `${row.student.name} ${row.percent}%${row.needToReach === null ? "" : ` (needs ${row.needToReach})`}`);
        const summary = report.held
            ? `${course.code}: ${plural(report.held, "class", "classes")} held, ${plural(report.students.length, "student")}. `
                + (defaulters.length ? `${defaulters.length} below ${report.threshold}%: ${list(defaulters, 15)}.` : `Nobody is below ${report.threshold}%.`)
            : `${course.code}: no classes have been held yet.`;
        const params = { courseId: idString(course._id), threshold: report.threshold };
        return {
            summary,
            data: {
                course: report.course,
                held: report.held,
                threshold: report.threshold,
                students: report.students.map((row) => ({
                    student: { _id: row.student._id, name: row.student.name, email: row.student.email },
                    attended: row.attended,
                    late: row.late,
                    absent: row.absent,
                    excused: row.excused,
                    held: row.held,
                    percent: row.percent,
                    status: row.status,
                    needToReach: row.needToReach,
                })),
                defaulterCount: report.defaulters.length,
            },
            ui: isStaffView(ctx) ? { panel: "tpo.attendance", params } : { panel: "teacher.analytics", params },
        };
    }),
};

const notifyDefaultersTool = {
    name: "attendance_notify_defaulters",
    description: "Send every student below the attendance threshold of a course a notification (in-app, push and "
        + "email when enabled) with their percentage, how many classes they need, and an optional message.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            course: COURSE_PARAM,
            threshold: { type: "number", minimum: 0, maximum: 100, description: "Default: the course minimum (usually 75)" },
            message: { type: "string", description: "Optional note from the teacher" },
        },
        required: ["course"],
    },
    preview: guard(async (args, ctx) => {
        requireUser(ctx);
        const course = await resolveCourse(args.course, ctx);
        const report = await buildCourseReport(course, { threshold: args.threshold });
        if (!report.defaulters.length) {
            return { ok: false, error: "NO_DEFAULTERS", message: `No student in ${course.code} is below ${report.threshold}%.` };
        }
        const names = report.defaulters.map((row) => `${row.student.name} ${row.percent}%`);
        return {
            summary: `Notify ${plural(report.defaulters.length, "student")} in ${course.code} below ${report.threshold}% (${list(names, 10)})`
                + `${args.message ? ` with your message "${args.message}"` : ""}?`,
            args: compact({ course: idString(course._id), threshold: args.threshold, message: args.message }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const course = await resolveCourse(args.course, ctx);
        const result = await notifyDefaulters(user, course._id, { threshold: args.threshold, message: args.message }, { now: nowOf(ctx) });
        const summary = result.defaulters
            ? `Notified ${plural(result.notified, "student")} below ${result.threshold}% in ${course.code}`
                + `${result.alreadyNotified ? ` (${result.alreadyNotified} already had this notice today)` : ""}.`
            : `No student in ${course.code} is below ${result.threshold}%.`;
        return {
            summary,
            data: result,
            ui: { panel: "teacher.analytics", params: { courseId: idString(course._id), threshold: result.threshold } },
        };
    }),
};

const markManualTool = {
    name: "attendance_mark_manual",
    description: "Manually set one student's attendance for a live or finished class (present, late, absent or excused, "
        + "with an optional note). Defaults to the teacher's live class, else the most recent one.",
    roles: TEACHER,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            session: SESSION_PARAM,
            course: COURSE_PARAM,
            student: { type: "string", description: "Student id, email, enrolment/roll number or name" },
            status: { type: "string", enum: [...RECORD_STATUSES] },
            note: { type: "string", description: "e.g. 'Medical certificate'" },
        },
        required: ["student", "status"],
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session, course } = await resolveSession(args, ctx, { statuses: ["live", "ended"], order: "recent", liveFirst: true });
        const student = await resolveStudent(args.student, course, session);
        const plan = await planMark(user, session._id, { studentId: idString(student._id), status: args.status, note: args.note });
        const current = await AttendanceRecord.findOne({ session: session._id, student: student._id }).select("status").lean();
        return {
            summary: `Mark ${studentLabel(student)} as ${plan.status} for ${sessionLabel(session, course)}${current ? ` (currently ${current.status})` : ""}`
                + `${plan.note ? ` — note: ${plan.note}` : ""}?`,
            args: compact({ session: idString(session._id), student: idString(student._id), status: plan.status, note: args.note }),
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { session, course } = await resolveSession(args, ctx, { statuses: ["live", "ended"], order: "recent", liveFirst: true });
        const student = await resolveStudent(args.student, course, session);
        const { record, stats } = await markRecord(user, session._id, { studentId: idString(student._id), status: args.status, note: args.note }, { now: nowOf(ctx) });
        return {
            summary: `Marked ${student.name} ${record.status} for ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}. Now ${statsLine(stats)}.`,
            data: { record, stats },
            ui: { panel: "teacher.report", params: { sessionId: idString(session._id) } },
        };
    }),
};

const mySummaryTool = {
    name: "attendance_my_summary",
    description: "The student's attendance: overall percentage and, per course, classes attended/held, status and how "
        + "many classes they must attend to reach (or may skip while staying above) the minimum.",
    roles: ["student"],
    confirm: false,
    parameters: {
        type: "object",
        properties: { course: { ...COURSE_PARAM, description: "Optional: one course (id, code or name)" } },
    },
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const course = args.course ? await resolveCourse(args.course, ctx, { includeArchived: true }) : null;
        const result = await mySummary(user);
        const rows = course ? result.courses.filter((row) => row.course._id === idString(course._id)) : result.courses;
        const line = (row) => {
            if (row.percent === null) return `${row.course.code}: no classes held yet`;
            const min = row.course.minAttendancePercent;
            const advice = row.percent < min
                ? (row.needToReach === null ? `${min}% is out of reach` : `attend the next ${plural(row.needToReach, "class", "classes")} to reach ${min}%`)
                : `you can miss ${plural(row.canSkip ?? 0, "class", "classes")} and stay at ${min}%`;
            return `${row.course.code} ${row.percent}% (${row.attended}/${row.held - row.excused}, ${row.status}) — ${advice}`;
        };
        const overall = result.overall.percent === null
            ? "No classes held yet."
            : `Overall ${result.overall.percent}% (${result.overall.attended}/${result.overall.held - result.overall.excused}).`;
        const summary = rows.length ? `${course ? "" : `${overall} `}${list(rows.map(line), 10)}.` : "You're not enrolled in any course yet.";
        return {
            summary,
            data: { courses: rows, overall: result.overall },
            ui: { panel: "attendance.student", params: compact({ courseId: course ? idString(course._id) : undefined }) },
        };
    }),
};

const myScheduleTool = {
    name: "attendance_my_schedule",
    description: "Upcoming classes for the next few days (students: enrolled courses; teachers: their own classes), "
        + "including live and cancelled ones.",
    roles: ["student", "teacher"],
    confirm: false,
    parameters: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 31, description: "How many days ahead (default 7)" } },
    },
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const { sessions, days } = await mySchedule(user, { days: args.days }, { now: nowOf(ctx) });
        const summary = sessions.length
            ? `${plural(sessions.length, "class", "classes")} in the next ${plural(days, "day")}: ${list(sessions.map(sessionLine))}.`
            : `No classes in the next ${plural(days, "day")}.`;
        const ui = user.role === "teacher" ? { panel: "teacher.schedule" } : { panel: "schedule", params: { days } };
        return { summary, data: { sessions, days }, ui };
    }),
};

const joinCourseTool = {
    name: "attendance_join_course",
    description: "Enrol the student in a course using the 6-character join code the teacher shared.",
    roles: ["student"],
    confirm: true,
    parameters: {
        type: "object",
        properties: { joinCode: { type: "string", description: "6-character join code, e.g. K7P2QD" } },
        required: ["joinCode"],
    },
    preview: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const code = String(args.joinCode).trim().toUpperCase().replace(/[\s-]/g, "");
        const course = await Course.findOne({ joinCode: code, status: "active" }).populate("teacher", "name").lean();
        if (!course) throw fail(404, "No course has this join code", "NOT_FOUND");
        const already = (course.students || []).some((id) => String(id) === String(user._id));
        return {
            summary: already
                ? `You're already enrolled in ${courseLabel(course)}. Join again anyway?`
                : `Join ${courseLabel(course)}${course.teacher?.name ? ` taught by ${course.teacher.name}` : ""}?`,
            args: { joinCode: code },
        };
    }),
    handler: guard(async (args, ctx) => {
        const user = requireUser(ctx);
        const course = await joinCourse(user, args.joinCode);
        return {
            summary: `You're enrolled in ${course.code} · ${course.name}. You'll get notifications for its classes.`,
            data: { course: serializeCourse(course, { manage: false }) },
            ui: { panel: "attendance.student", params: { courseId: idString(course._id) } },
        };
    }),
};

const openScannerTool = {
    name: "attendance_open_scanner",
    description: "Open the QR scanner so the student can mark attendance by scanning the code shown in class.",
    roles: ["student"],
    confirm: false,
    parameters: { type: "object", properties: {} },
    handler: guard(async (_args, ctx) => {
        const user = requireUser(ctx);
        const courseIds = await Course.find({ students: user._id, status: "active" }).distinct("_id");
        const live = await ClassSession.find({ course: { $in: courseIds }, status: "live" }).populate("course", "code name").sort({ startsAt: 1 }).lean();
        const marked = live.length
            ? new Set((await AttendanceRecord.find({ student: user._id, session: { $in: live.map((session) => session._id) } }).distinct("session")).map(String))
            : new Set();
        const open = live.filter((session) => !marked.has(String(session._id)));
        let summary;
        if (open.length) {
            summary = `Opening the scanner. ${open.map((session) => session.course?.code).join(", ")} ${open.length === 1 ? "is" : "are"} taking attendance now — point your camera at the QR code.`;
        } else if (live.length) summary = "Opening the scanner. Your attendance in the live class is already marked.";
        else summary = "Opening the scanner. None of your classes is taking attendance right now.";
        return {
            summary,
            data: { liveSessions: live.map((session) => ({ ...serializeSession(session), alreadyMarked: marked.has(String(session._id)) })) },
            ui: { panel: "attendance.scan" },
        };
    }),
};

export default [
    listCoursesTool,
    createCourseTool,
    listSessionsTool,
    scheduleTool,
    autoScheduleTool,
    rescheduleTool,
    cancelTool,
    startTool,
    endTool,
    sessionReportTool,
    courseReportTool,
    notifyDefaultersTool,
    markManualTool,
    mySummaryTool,
    myScheduleTool,
    joinCourseTool,
    openScannerTool,
];
