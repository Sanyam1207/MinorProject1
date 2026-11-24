// Presenter room (ATTENDANCE.md "Socket.IO"): the teacher's phone/projector
// joins `attendance:presenter:<sessionId>` to receive attendance:qr and
// attendance:marked. Only the owning teacher (or tpo/admin) of a LIVE session may join.
import { isObjectId } from "../../core/http.js";
import { rooms } from "../../core/realtime.js";
import { isOversight, isOwner } from "./access.js";
import { EVENTS } from "./events.js";
import { ClassSession, Course } from "./models/index.js";
import { qrPayload, rotateIfExpired } from "./qr.js";
import { sameId, serializeSession } from "./serializers.js";

const refuse = (reply, error, message, extra = {}) => reply({ ok: false, error, message, ...extra });

export const handlePresenterJoin = async (socket, payload, reply) => {
    const user = socket.data?.user;
    if (!user?._id) return refuse(reply, "UNAUTHORIZED", "Sign in to present attendance.");
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!isObjectId(sessionId)) return refuse(reply, "VALIDATION", "sessionId must be a valid id.");
    const session = await ClassSession.findById(sessionId).lean();
    if (!session) return refuse(reply, "NOT_FOUND", "Class session not found.");
    const course = await Course.findById(session.course).lean();
    const allowed = sameId(session.teacher, user._id) || (course && isOwner(user, course)) || isOversight(user);
    if (!allowed) return refuse(reply, "FORBIDDEN", "Only the class's teacher can present its QR code.");
    if (session.status !== "live") {
        return refuse(reply, "SESSION_NOT_LIVE", "Attendance for this class isn't open.", { session: serializeSession(session, { course }) });
    }
    const room = rooms.presenter(sessionId);
    // Join first so no rotation between reading the QR and joining is missed.
    await socket.join(room);
    const { session: live } = await rotateIfExpired(session._id);
    if (!live) {
        await socket.leave(room);
        return refuse(reply, "SESSION_NOT_LIVE", "Attendance for this class isn't open.");
    }
    const serialized = serializeSession(live, { course });
    return reply({ ok: true, qr: qrPayload(live), stats: serialized.stats, session: serialized });
};

export const registerAttendanceSocket = (_io, socket) => {
    socket.on(EVENTS.PRESENTER_JOIN, async (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
            await handlePresenterJoin(socket, payload, reply);
        } catch (error) {
            console.error("[attendance] presenter join failed:", error);
            reply({ ok: false, error: "INTERNAL", message: "Could not open the presenter." });
        }
    });
    socket.on(EVENTS.PRESENTER_LEAVE, async (payload, ack) => {
        const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
        if (isObjectId(sessionId)) await socket.leave(rooms.presenter(sessionId));
        if (typeof ack === "function") ack({ ok: true });
    });
};
