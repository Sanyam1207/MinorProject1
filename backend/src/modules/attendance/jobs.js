// Background jobs (core/scheduler.js; disabled under NODE_ENV=test — tests call
// these functions directly):
//   attendance:qr-rotation   every 1 s  rotate expired QR tokens of live sessions, push attendance:qr
//   attendance:reminders     every 60 s notify students + teacher of classes starting within 15 min
//   attendance:auto-end      every 60 s finalise live sessions past endsAt + autoEndGraceMinutes
//   attendance:timetable     every 6 h (and at boot) materialise timetables
import { registerJob } from "../../core/scheduler.js";
import { DEFAULT_SETTINGS, REMINDER_LEAD_MINUTES } from "./config.js";
import { ClassSession, Course } from "./models/index.js";
import { notifyReminder } from "./notifications.js";
import { rotateExpiredTokens } from "./qr.js";
import { finaliseSession, materialiseAllTimetables } from "./sessions.service.js";

export const JOBS = Object.freeze({
    QR_ROTATION: "attendance:qr-rotation",
    REMINDERS: "attendance:reminders",
    AUTO_END: "attendance:auto-end",
    TIMETABLE: "attendance:timetable",
});

/** Reminders for scheduled sessions starting within 15 minutes (once per start time). */
export const sendDueReminders = async ({ now = new Date() } = {}) => {
    const horizon = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60_000);
    const due = await ClassSession.find({
        status: "scheduled",
        reminderSentAt: null,
        startsAt: { $gt: now, $lte: horizon },
    }).select("_id").lean();
    let sent = 0;
    for (const { _id } of due) {
        // Claim the reminder atomically so parallel ticks/instances never double-send.
        const session = await ClassSession.findOneAndUpdate(
            { _id, status: "scheduled", reminderSentAt: null },
            { $set: { reminderSentAt: now } },
            { returnDocument: "after" },
        ).lean();
        if (!session) continue;
        const course = await Course.findById(session.course).lean();
        if (!course || course.status !== "active") continue;
        await notifyReminder(session, course);
        sent += 1;
    }
    return sent;
};

/** Finalise live sessions whose end + grace has passed. */
export const autoEndSessions = async ({ now = new Date() } = {}) => {
    const live = await ClassSession.find({ status: "live", endsAt: { $lt: now } }).select("_id course endsAt").lean();
    if (!live.length) return 0;
    const courses = await Course.find({ _id: { $in: [...new Set(live.map((session) => String(session.course)))] } })
        .select("settings").lean();
    const graceByCourse = new Map(courses.map((course) => [String(course._id), course.settings?.autoEndGraceMinutes ?? DEFAULT_SETTINGS.autoEndGraceMinutes]));
    let ended = 0;
    for (const session of live) {
        const grace = graceByCourse.get(String(session.course)) ?? DEFAULT_SETTINGS.autoEndGraceMinutes;
        if (session.endsAt.getTime() + grace * 60_000 >= now.getTime()) continue;
        const result = await finaliseSession(session._id, { now });
        if (result) ended += 1;
    }
    return ended;
};

/** Time-based QR rotation tick. */
export const rotateQrTokens = ({ now = new Date() } = {}) => rotateExpiredTokens(now);

/** Timetable materialisation run. */
export const materialiseTimetables = ({ now = new Date() } = {}) => materialiseAllTimetables({ now });

export const registerAttendanceJobs = () => {
    registerJob(JOBS.QR_ROTATION, 1_000, () => rotateQrTokens());
    registerJob(JOBS.REMINDERS, 60_000, () => sendDueReminders());
    registerJob(JOBS.AUTO_END, 60_000, () => autoEndSessions());
    registerJob(JOBS.TIMETABLE, 6 * 60 * 60_000, () => materialiseTimetables(), { runOnStart: true });
};
