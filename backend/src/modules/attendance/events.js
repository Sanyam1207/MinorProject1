// Socket.IO events of the attendance module (ATTENDANCE.md "Socket.IO").
//   attendance:qr        → presenter room   {sessionId, token, version, expiresAt, url, rotationSeconds}
//   attendance:marked    → presenter room   {sessionId, record:{student, status, method, markedAt, flags}, stats}
//   attendance:session   → user rooms of the teacher + enrolled students (and the presenter room) {session}
//   attendance:confirmed → user room of the scanning student {sessionId, status, course:{code, name}}
import { emitToRoom, emitToUser, getIO, rooms } from "../../core/realtime.js";
import { idString, serializeSession, userCard } from "./serializers.js";

export const EVENTS = Object.freeze({
    QR: "attendance:qr",
    MARKED: "attendance:marked",
    SESSION: "attendance:session",
    CONFIRMED: "attendance:confirmed",
    PRESENTER_JOIN: "attendance:presenter:join",
    PRESENTER_LEAVE: "attendance:presenter:leave",
});

export const emitQr = (payload) => emitToRoom(rooms.presenter(payload.sessionId), EVENTS.QR, payload);

export const emitMarked = (session, record, student) => emitToRoom(rooms.presenter(session._id), EVENTS.MARKED, {
    sessionId: idString(session._id),
    record: {
        _id: idString(record._id),
        student: (() => {
            const card = userCard(student || record.student);
            return card ? { _id: card._id, name: card.name ?? "", email: card.email ?? "", ggsipuEnrollment: card.ggsipuEnrollment ?? null } : null;
        })(),
        status: record.status,
        method: record.method,
        markedAt: record.markedAt,
        flags: Array.isArray(record.flags) ? [...record.flags] : [],
        note: record.note ?? null,
    },
    stats: { ...session.stats },
});

/** One emit to every affected socket (socket.io de-duplicates sockets across rooms). */
export const emitSessionChanged = (session, course) => {
    const io = getIO();
    if (!io || !session) return false;
    const targets = new Set([rooms.user(idString(session.teacher)), rooms.presenter(idString(session._id))]);
    if (course?.teacher) targets.add(rooms.user(idString(course.teacher)));
    for (const student of course?.students || []) targets.add(rooms.user(idString(student)));
    io.to([...targets]).emit(EVENTS.SESSION, { session: serializeSession(session, { course }) });
    return true;
};

export const emitConfirmed = (studentId, session, course, status) => emitToUser(idString(studentId), EVENTS.CONFIRMED, {
    sessionId: idString(session._id),
    status,
    course: { _id: idString(course._id), code: course.code, name: course.name },
});
