// Attendance percentages (ATTENDANCE.md "Percentages").
//
//   attended = present + late; excused leaves the denominator:
//   percent  = attended / (held − excused) × 100, null when nothing counts yet.
//   needToReach = fewest future consecutive attended classes that bring the
//                 percentage to the threshold (0 when already there, null when unreachable).
//   canSkip     = most classes that can be missed while staying at/above the threshold.
//   status      = safe (≥ threshold + 5) | warning (≥ threshold) | critical | no-data.
//
// `held` per student counts the ENDED sessions of the course the student has a
// record for. Finalising a session gives every enrolled student a record
// (absent when unmarked), so for a student enrolled from the start this equals
// the course's ended-session count; a student who joined late is not charged
// for classes held before they enrolled.
import mongoose from "mongoose";
import { AttendanceRecord, ClassSession } from "./models/index.js";

const EPSILON = 1e-9;

export const roundPercent = (value) => Math.round(value * 10) / 10;

export const computePercent = (attended, held, excused = 0) => {
    const countable = held - excused;
    return countable > 0 ? roundPercent((attended / countable) * 100) : null;
};

export const computeNeedToReach = (attended, countable, threshold) => {
    if (countable <= 0) return 0;
    if (attended * 100 >= threshold * countable - EPSILON) return 0;
    if (threshold >= 100) return null; // a missed class can never be made up to 100 %
    return Math.max(0, Math.ceil((threshold * countable - 100 * attended) / (100 - threshold) - EPSILON));
};

export const computeCanSkip = (attended, countable, threshold) => {
    if (threshold <= 0) return null; // unlimited
    if (countable <= 0 && attended <= 0) return 0;
    return Math.max(0, Math.floor((100 * attended) / threshold - countable + EPSILON));
};

export const attendanceStatus = (percent, threshold) => {
    if (percent === null || percent === undefined) return "no-data";
    if (percent >= threshold + 5) return "safe";
    if (percent >= threshold) return "warning";
    return "critical";
};

/** Full summary from raw status counts. */
export const summarise = ({ present = 0, late = 0, absent = 0, excused = 0 } = {}, threshold = 75) => {
    const attended = present + late;
    const held = present + late + absent + excused;
    const countable = held - excused;
    const percent = computePercent(attended, held, excused);
    return {
        attended,
        present,
        late,
        absent,
        excused,
        held,
        percent,
        status: attendanceStatus(percent, threshold),
        needToReach: percent === null ? 0 : computeNeedToReach(attended, countable, threshold),
        canSkip: percent === null ? 0 : computeCanSkip(attended, countable, threshold),
    };
};

const toObjectIds = (values) => values.map((value) => new mongoose.Types.ObjectId(String(value)));

const emptyCounts = () => ({ present: 0, late: 0, absent: 0, excused: 0 });

/**
 * Status counts over ended sessions, grouped by `groupBy` ("student" or "course").
 * @returns {Promise<Map<string, {present, late, absent, excused}>>}
 */
export const countRecords = async ({ courseIds, studentIds = null, groupBy = "student" }) => {
    const result = new Map();
    if (!courseIds?.length) return result;
    const ended = await ClassSession.find({ course: { $in: toObjectIds(courseIds) }, status: "ended" }).distinct("_id");
    if (!ended.length) return result;
    const match = { session: { $in: ended } };
    if (studentIds) match.student = { $in: toObjectIds(studentIds) };
    const rows = await AttendanceRecord.aggregate([
        { $match: match },
        { $group: { _id: { key: `$${groupBy}`, status: "$status" }, count: { $sum: 1 } } },
    ]);
    for (const row of rows) {
        const key = String(row._id.key);
        if (!result.has(key)) result.set(key, emptyCounts());
        const counts = result.get(key);
        if (row._id.status in counts) counts[row._id.status] += row.count;
    }
    return result;
};

/** Number of ended sessions per course id. */
export const heldByCourse = async (courseIds) => {
    const result = new Map();
    if (!courseIds?.length) return result;
    const rows = await ClassSession.aggregate([
        { $match: { course: { $in: toObjectIds(courseIds) }, status: "ended" } },
        { $group: { _id: "$course", count: { $sum: 1 } } },
    ]);
    for (const row of rows) result.set(String(row._id), row.count);
    return result;
};

/** One student's summary per course. */
export const studentCourseSummaries = async (studentId, courses) => {
    const counts = await countRecords({ courseIds: courses.map((course) => course._id), studentIds: [studentId], groupBy: "course" });
    const map = new Map();
    for (const course of courses) {
        const threshold = course.settings?.minAttendancePercent ?? 75;
        map.set(String(course._id), summarise(counts.get(String(course._id)) || emptyCounts(), threshold));
    }
    return map;
};

/** Every listed student's summary in one course. */
export const courseStudentSummaries = async (course, studentIds, threshold) => {
    const counts = await countRecords({ courseIds: [course._id], studentIds, groupBy: "student" });
    const map = new Map();
    for (const studentId of studentIds) {
        map.set(String(studentId), summarise(counts.get(String(studentId)) || emptyCounts(), threshold));
    }
    return map;
};

/** Recount one session's stats from its records. */
export const recountSessionStats = async (sessionId, enrolled) => {
    const rows = await AttendanceRecord.aggregate([
        { $match: { session: new mongoose.Types.ObjectId(String(sessionId)) } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const stats = { ...emptyCounts(), enrolled };
    for (const row of rows) if (row._id in stats) stats[row._id] = row.count;
    return stats;
};
