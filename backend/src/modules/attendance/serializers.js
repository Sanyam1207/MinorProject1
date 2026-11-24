// Response shapes of the attendance API. The QR nonce and device hashes never
// leave the server through these helpers (the QR has its own payload, qr.js).

export const idOf = (value) => (value && typeof value === "object" && value._id ? value._id : value);
export const idString = (value) => (value === null || value === undefined ? null : String(idOf(value)));
export const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && idString(a) === idString(b);

const isPopulated = (value) => Boolean(value) && typeof value === "object" && value._id !== undefined && ("name" in value || "email" in value || "code" in value);

/** Public card of a user (students in rosters, teachers on courses). */
export const userCard = (user) => {
    if (!user) return null;
    if (!isPopulated(user)) return { _id: idString(user) };
    return {
        _id: idString(user),
        name: user.name ?? "",
        email: user.email ?? "",
        ggsipuEnrollment: user.ggsipuEnrollment ?? null,
        rollNumber: user.rollNumber ?? null,
        branch: user.branch ?? null,
        section: user.section ?? null,
    };
};

const teacherCard = (teacher) => {
    if (!teacher) return null;
    if (!isPopulated(teacher)) return { _id: idString(teacher) };
    return { _id: idString(teacher), name: teacher.name ?? "", email: teacher.email ?? "" };
};

export const courseRef = (course) => {
    if (!course) return null;
    if (!isPopulated(course)) return { _id: idString(course) };
    return { _id: idString(course), code: course.code, name: course.name };
};

const plain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

/**
 * @param {object} course Course doc or lean object
 * @param {{manage?: boolean}} options manage=true (owner, tpo, admin): include joinCode
 */
export const serializeCourse = (course, { manage = false } = {}) => {
    const value = plain(course);
    if (!value) return null;
    const out = {
        _id: idString(value._id),
        code: value.code,
        name: value.name,
        teacher: teacherCard(value.teacher),
        department: value.department ?? null,
        branch: value.branch ?? null,
        semester: value.semester ?? null,
        section: value.section ?? null,
        passingYear: value.passingYear ?? null,
        academicYear: value.academicYear ?? null,
        room: value.room ?? null,
        timetable: (value.timetable || []).map((slot) => ({
            day: slot.day,
            start: slot.start,
            durationMinutes: slot.durationMinutes,
            room: slot.room ?? null,
        })),
        settings: { ...(value.settings || {}) },
        status: value.status,
        studentCount: Array.isArray(value.students) ? value.students.length : 0,
        createdAt: value.createdAt ?? null,
        updatedAt: value.updatedAt ?? null,
    };
    if (manage) out.joinCode = value.joinCode;
    return out;
};

/**
 * @param {object} session ClassSession doc or lean object
 * @param {{now?: Date, course?: object, includeGeo?: boolean}} options
 */
export const serializeSession = (session, { now = new Date(), course = null, includeGeo = false } = {}) => {
    const value = plain(session);
    if (!value) return null;
    const startsAt = value.startsAt ? new Date(value.startsAt) : null;
    const endsAt = value.endsAt ? new Date(value.endsAt) : null;
    const out = {
        _id: idString(value._id),
        course: courseRef(course || value.course),
        teacher: teacherCard(value.teacher),
        topic: value.topic ?? "",
        room: value.room ?? null,
        mode: value.mode ?? "offline",
        startsAt,
        endsAt,
        durationMinutes: startsAt && endsAt ? Math.round((endsAt - startsAt) / 60_000) : null,
        status: value.status,
        source: value.source ?? "manual",
        cancelReason: value.cancelReason ?? null,
        cancelledAt: value.cancelledAt ?? null,
        liveStartedAt: value.liveStartedAt ?? null,
        endedAt: value.endedAt ?? null,
        isLive: value.status === "live",
        isMissed: value.status === "scheduled" && Boolean(endsAt) && endsAt < now,
        stats: {
            present: value.stats?.present ?? 0,
            late: value.stats?.late ?? 0,
            absent: value.stats?.absent ?? 0,
            excused: value.stats?.excused ?? 0,
            enrolled: value.stats?.enrolled ?? 0,
        },
        createdAt: value.createdAt ?? null,
        updatedAt: value.updatedAt ?? null,
    };
    if (includeGeo && value.geo && typeof value.geo.lat === "number") {
        out.geo = { lat: value.geo.lat, lng: value.geo.lng, accuracy: value.geo.accuracy ?? null, radiusMeters: value.geo.radiusMeters ?? null };
    }
    return out;
};

export const serializeRecord = (record, { student = null } = {}) => {
    const value = plain(record);
    if (!value) return null;
    const out = {
        _id: idString(value._id),
        session: idString(value.session),
        course: idString(value.course),
        student: userCard(student || value.student),
        status: value.status,
        method: value.method,
        markedAt: value.markedAt ?? null,
        markedBy: idString(value.markedBy),
        qrVersion: value.qrVersion ?? null,
        flags: Array.isArray(value.flags) ? [...value.flags] : [],
        note: value.note ?? null,
    };
    if (value.geo && typeof value.geo.lat === "number") {
        out.geo = {
            lat: value.geo.lat,
            lng: value.geo.lng,
            accuracy: value.geo.accuracy ?? null,
            distanceMeters: value.geo.distanceMeters ?? null,
        };
    }
    return out;
};
