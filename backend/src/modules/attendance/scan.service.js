// POST /scan — a student scans the live QR (ATTENDANCE.md rules 3–7).
//
// Order: rate limit → session exists & live → enrolled → not already marked →
// device not used for another student → geofence → consume the token
// atomically → insert the record. Every check runs BEFORE the token is
// consumed, so a rejected scan never burns the teacher's current QR.
import { isObjectId, fail } from "../../core/http.js";
import { createLimiter } from "../../core/rate-limit.js";
import { isEnrolled } from "./access.js";
import { DEFAULT_SETTINGS, GEO_ACCURACY_CAP_METERS, SCAN_RATE_LIMIT, hashDevice } from "./config.js";
import { emitConfirmed, emitMarked, emitQr } from "./events.js";
import { AttendanceRecord, ClassSession, Course } from "./models/index.js";
import { consumeToken, qrPayload } from "./qr.js";
import { idString } from "./serializers.js";
import { parseGeo } from "./sessions.service.js";
import { computePercent, studentCourseSummaries } from "./stats.js";

const scanLimiter = createLimiter(SCAN_RATE_LIMIT);

const invalidToken = () => fail(400, "This QR code isn't valid. Scan the code your teacher is showing.", "INVALID_TOKEN");
const notLive = () => fail(409, "Attendance for this class isn't open.", "SESSION_NOT_LIVE");

/** Great-circle distance in metres. */
export const distanceMeters = (a, b) => {
    const radius = 6_371_000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
};

const isDuplicate = (error) => error?.code === 11000;
const duplicateOnDevice = (error) => Object.keys(error?.keyPattern || error?.keyValue || {}).includes("deviceHash");

/**
 * @param {object} user the scanning student
 * @param {{sessionId: string, token: string, deviceId: string, geo?: {lat, lng, accuracy}}} body
 * @returns {Promise<{status, markedAt, session:{_id, topic, startsAt, endsAt}, course:{_id, code, name}, summary:{attended, held, percent}}>}
 */
export const scan = async (user, body = {}, { now = new Date() } = {}) => {
    if (!scanLimiter.hit(`scan:${idString(user._id)}`)) {
        throw fail(429, "Too many attempts. Wait a minute and try again.", "TOO_MANY_ATTEMPTS");
    }
    const { sessionId, token, deviceId, geo } = body || {};
    // Only plain strings reach the database (an object here could be a query operator).
    if (typeof sessionId !== "string" || !isObjectId(sessionId.trim())) throw invalidToken();
    if (typeof token !== "string" || !token.trim() || token.length > 128) throw invalidToken();
    if (typeof deviceId !== "string" || !deviceId.trim() || deviceId.length > 200) {
        throw fail(400, "deviceId is required", "VALIDATION", { field: "deviceId" });
    }

    const session = await ClassSession.findById(sessionId.trim()).lean();
    if (!session) throw invalidToken();
    if (session.status !== "live") throw notLive();
    const course = await Course.findById(session.course).lean();
    if (!course || !isEnrolled(user, course)) {
        throw fail(403, "You're not enrolled in this course. Ask your teacher for the join code.", "NOT_ENROLLED");
    }

    const existing = await AttendanceRecord.findOne({ session: session._id, student: user._id }).select("status").lean();
    if (existing) {
        throw fail(409, "Your attendance is already marked for this class.", "ALREADY_MARKED", { status: existing.status });
    }

    const deviceHash = hashDevice(deviceId.trim());
    const deviceUsed = await AttendanceRecord.exists({ session: session._id, deviceHash, student: { $ne: user._id } });
    if (deviceUsed) throw fail(403, "This phone was already used to mark another student in this class.", "DEVICE_ALREADY_USED");

    const settings = { ...DEFAULT_SETTINGS, ...(course.settings || {}) };
    const flags = [];
    const point = parseGeo(geo);
    let geoRecord;
    const classroom = session.geo && typeof session.geo.lat === "number" && typeof session.geo.lng === "number" ? session.geo : null;
    if (settings.requireGeo && classroom) {
        if (!point) throw fail(400, "This class needs your location. Allow location access and scan again.", "LOCATION_REQUIRED");
        const distance = distanceMeters(classroom, point);
        const radius = classroom.radiusMeters ?? settings.geoRadiusMeters;
        const tolerance = radius + Math.min(point.accuracy ?? 0, GEO_ACCURACY_CAP_METERS);
        if (distance > tolerance) {
            throw fail(403, "You seem to be outside the classroom. Move closer and scan again.", "OUT_OF_RANGE", {
                distanceMeters: Math.round(distance),
                allowedMeters: Math.round(tolerance),
            });
        }
        geoRecord = { ...point, distanceMeters: Math.round(distance) };
    } else if (point) {
        geoRecord = { ...point, ...(classroom ? { distanceMeters: Math.round(distanceMeters(classroom, point)) } : {}) };
    }
    if (geoRecord && (geoRecord.accuracy ?? 0) > GEO_ACCURACY_CAP_METERS) flags.push("low-accuracy-geo");
    if (geoRecord && geoRecord.accuracy === null) delete geoRecord.accuracy;

    const [usedThisDevice, usedAnyDevice] = await Promise.all([
        AttendanceRecord.exists({ student: user._id, deviceHash }),
        AttendanceRecord.exists({ student: user._id, method: "qr", deviceHash: { $type: "string" } }),
    ]);
    if (usedAnyDevice && !usedThisDevice) flags.push("new-device");

    // The single atomic step: exactly one concurrent scan of this token wins.
    const rotationSeconds = session.qr?.rotationSeconds || settings.qrRotationSeconds;
    const consumed = await consumeToken(session._id, token.trim(), rotationSeconds, now);
    if (!consumed) {
        const current = await ClassSession.findById(session._id).select("status").lean();
        if (!current || current.status !== "live") throw notLive();
        throw fail(410, "This QR code has expired. Scan the code on the screen again.", "TOKEN_EXPIRED");
    }
    // The scanned token is gone either way: the presenter shows the new one immediately.
    emitQr(qrPayload(consumed));

    const status = now.getTime() > new Date(session.startsAt).getTime() + settings.lateAfterMinutes * 60_000 ? "late" : "present";
    let record;
    try {
        record = await AttendanceRecord.create({
            session: session._id,
            course: course._id,
            student: user._id,
            status,
            method: "qr",
            markedAt: now,
            qrVersion: consumed.qr.version - 1,
            deviceHash,
            ...(geoRecord ? { geo: geoRecord } : {}),
            flags,
        });
    } catch (error) {
        if (isDuplicate(error)) {
            if (duplicateOnDevice(error)) throw fail(403, "This phone was already used to mark another student in this class.", "DEVICE_ALREADY_USED");
            throw fail(409, "Your attendance is already marked for this class.", "ALREADY_MARKED");
        }
        throw error;
    }

    const updated = await ClassSession.findOneAndUpdate(
        { _id: session._id },
        { $inc: { [`stats.${status}`]: 1 } },
        { returnDocument: "after" },
    ).lean();
    emitMarked(updated || session, record, user);
    emitConfirmed(user._id, session, course, status);

    // Summary including this class (it counts once the session is finalised).
    const before = (await studentCourseSummaries(user._id, [course])).get(String(course._id));
    const attended = before.attended + 1;
    const held = before.held + 1;
    return {
        status,
        markedAt: record.markedAt,
        session: { _id: idString(session._id), topic: session.topic || "", startsAt: session.startsAt, endsAt: session.endsAt },
        course: { _id: idString(course._id), code: course.code, name: course.name },
        summary: { attended, held, percent: computePercent(attended, held, before.excused) },
    };
};
