// Attendance notifications through notify() (NOTIFICATIONS.md) with the UI
// actions of UI-ACTIONS.md §11. A failed notification never fails the action
// that caused it.
import { notify } from "../notifications/notify.js";
import { idString } from "./serializers.js";
import { formatSlot, formatTime } from "./time.js";

const log = (error) => console.error("[attendance] notification failed:", error?.message || error);

export const safeNotify = async (userIds, payload) => {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).map(idString).filter(Boolean);
    if (!ids.length) return { created: 0 };
    try {
        return await notify(ids, payload);
    } catch (error) {
        log(error);
        return { created: 0 };
    }
};

export const studentScheduleUi = () => ({ panel: "schedule" });
export const teacherScheduleUi = (params = {}) => ({ panel: "teacher.schedule", params });
export const studentAttendanceUi = (courseId) => ({ panel: "attendance.student", params: { courseId: idString(courseId) } });

const data = (session, course, extra = {}) => ({
    sessionId: idString(session._id),
    courseId: idString(course._id),
    courseCode: course.code,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    ...extra,
});

const where = (session, course) => {
    const parts = [course.name];
    if (session.topic) parts[0] = `${course.name} — ${session.topic}`;
    const room = session.room || course.room;
    if (session.mode === "online") parts.push("Online");
    else if (room) parts.push(`Room ${room}`);
    return parts.join(" · ");
};

export const notifyScheduled = (session, course) => safeNotify(course.students, {
    type: "attendance.scheduled",
    title: `New class: ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}`,
    body: where(session, course),
    ui: studentScheduleUi(),
    data: data(session, course),
    dedupeKey: `scheduled:${idString(session._id)}`,
});

export const notifyRescheduled = (session, course, previous) => {
    const moved = previous && previous.startsAt && new Date(previous.startsAt).getTime() !== new Date(session.startsAt).getTime();
    const title = moved
        ? `Class rescheduled: ${course.code} → ${formatSlot(session.startsAt, session.endsAt)}`
        : `Class updated: ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}`;
    const body = moved
        ? `Was ${formatSlot(previous.startsAt, previous.endsAt)}. ${where(session, course)}`
        : where(session, course);
    return safeNotify(course.students, {
        type: "attendance.rescheduled",
        title,
        body,
        ui: studentScheduleUi(),
        data: data(session, course, previous ? { previousStartsAt: previous.startsAt } : {}),
        priority: "high",
        dedupeKey: `rescheduled:${idString(session._id)}:${new Date(session.startsAt).getTime()}:${session.room || ""}:${session.mode}:${Date.now()}`,
    });
};

export const notifyCancelled = (session, course) => safeNotify(course.students, {
    type: "attendance.cancelled",
    title: `Class cancelled: ${course.code} · ${formatSlot(session.startsAt, session.endsAt)}`,
    body: session.cancelReason ? `Reason: ${session.cancelReason}` : `${course.name} will not take place.`,
    ui: studentScheduleUi(),
    data: data(session, course, { reason: session.cancelReason || null }),
    priority: "high",
    dedupeKey: `cancelled:${idString(session._id)}`,
});

export const notifyReminder = async (session, course) => {
    const key = `reminder:${idString(session._id)}:${new Date(session.startsAt).getTime()}`;
    const title = `Class at ${formatTime(session.startsAt)}: ${course.code}`;
    const body = `${where(session, course)} — starts in less than 15 minutes.`;
    const [students, teacher] = await Promise.all([
        safeNotify(course.students, {
            type: "attendance.reminder", title, body, ui: studentScheduleUi(), data: data(session, course), dedupeKey: key,
        }),
        safeNotify(session.teacher, {
            type: "attendance.reminder",
            title,
            body: `${body} Start attendance when you're in class.`,
            ui: teacherScheduleUi({ sessionId: idString(session._id) }),
            data: data(session, course),
            dedupeKey: key,
        }),
    ]);
    return { created: students.created + teacher.created };
};

export const notifyLive = (session, course) => safeNotify(course.students, {
    type: "attendance.live",
    title: `Attendance is open for ${course.code} — scan the QR in class`,
    body: where(session, course),
    ui: { panel: "attendance.scan" },
    data: data(session, course),
    priority: "high",
    dedupeKey: `live:${idString(session._id)}`,
});

export const notifyManualMark = (record, session, course) => safeNotify(record.student, {
    type: "attendance.marked",
    title: `${course.code}: marked ${record.status} for ${formatSlot(session.startsAt, session.endsAt)}`,
    body: record.note ? `Note from your teacher: ${record.note}` : `Your teacher updated your attendance in ${course.name}.`,
    ui: studentAttendanceUi(course._id),
    data: data(session, course, { status: record.status }),
    priority: "low",
    push: false,
    dedupeKey: `marked:${idString(session._id)}:${record.status}:${new Date(record.markedAt || Date.now()).getTime()}`,
});

export const lowAttendanceText = (course, summary, threshold) => {
    const percent = summary.percent === null ? "—" : `${summary.percent}%`;
    const next = summary.needToReach === null
        ? `${threshold}% can no longer be reached this term — talk to your teacher.`
        : `Attend the next ${summary.needToReach} class${summary.needToReach === 1 ? "" : "es"} to reach ${threshold}%.`;
    return { title: `Your attendance in ${course.code} is ${percent}`, body: next };
};

export const notifyLowAttendance = (studentId, course, summary, threshold, { dedupeKey, message = null, email = false } = {}) => {
    const text = lowAttendanceText(course, summary, threshold);
    return safeNotify(studentId, {
        type: "attendance.low",
        title: text.title,
        body: message ? `${message}\n\n${text.body}` : `${text.title} — ${text.body.charAt(0).toLowerCase()}${text.body.slice(1)}`,
        ui: studentAttendanceUi(course._id),
        data: { courseId: idString(course._id), courseCode: course.code, percent: summary.percent, needToReach: summary.needToReach, threshold },
        priority: "high",
        dedupeKey,
        email,
    });
};
