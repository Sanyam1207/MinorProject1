// Pure view-model helpers for the student attendance panels (no JSX).
import { attendanceErrorMessage } from "../../../lib/api/attendance.js";

export const DEFAULT_MIN_PERCENT = 75;

const asArray = (value, key) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
};

const num = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const numOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const standingFor = (percent, threshold = DEFAULT_MIN_PERCENT) => {
  if (percent === null || percent === undefined) return "no-data";
  if (percent >= threshold + 5) return "safe";
  if (percent >= threshold) return "warning";
  return "critical";
};

const STANDINGS = new Set(["safe", "warning", "critical", "no-data"]);

/** GET /me/summary (any tolerated shape) → `{ courses: CourseRow[], overall }`. */
export function normalizeSummary(raw) {
  const courses = asArray(raw, "courses").map((row) => {
    const course = row?.course && typeof row.course === "object" ? row.course : {};
    const min = num(course.minAttendancePercent, DEFAULT_MIN_PERCENT);
    const percent = numOrNull(row?.percent);
    return {
      id: String(course._id ?? row?.courseId ?? ""),
      code: course.code || "COURSE",
      name: course.name || "",
      section: course.section || null,
      teacherName: course.teacher?.name || null,
      archived: course.status === "archived",
      min,
      attended: num(row?.attended),
      present: num(row?.present),
      late: num(row?.late),
      absent: num(row?.absent),
      excused: num(row?.excused),
      held: num(row?.held),
      percent,
      status: STANDINGS.has(row?.status) ? row.status : standingFor(percent, min),
      needToReach: row?.needToReach === null ? null : num(row?.needToReach),
      canSkip: row?.canSkip === null ? null : num(row?.canSkip),
    };
  });
  const overallRaw = raw?.overall && typeof raw.overall === "object" ? raw.overall : {};
  const threshold = num(overallRaw.threshold, DEFAULT_MIN_PERCENT);
  const overallPercent = numOrNull(overallRaw.percent);
  return {
    courses,
    overall: {
      attended: num(overallRaw.attended),
      held: num(overallRaw.held),
      percent: overallPercent,
      threshold,
      status: STANDINGS.has(overallRaw.status) ? overallRaw.status : standingFor(overallPercent, threshold),
    },
  };
}

export const normalizeSessions = (raw) => asArray(raw, "sessions").filter((session) => session && typeof session === "object");
export const normalizeHistory = (raw) => asArray(raw, "records").filter((record) => record && typeof record === "object");

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "es"}`;

/** The one-line advice under a course: needToReach / canSkip. */
export function standingAdvice(row) {
  if (!row || row.percent === null) return "No classes held yet — your percentage starts with the first class.";
  if (row.percent < row.min) {
    if (row.needToReach === null) return `You can't reach ${row.min}% this term any more. Talk to your teacher.`;
    return `Attend the next ${plural(row.needToReach, "class")} in a row to reach ${row.min}%.`;
  }
  if (row.canSkip === null) return "No minimum attendance for this course.";
  if (row.canSkip > 0) return `You can miss ${plural(row.canSkip, "class")} and stay above ${row.min}%.`;
  return `Don't miss the next class — you're right at the ${row.min}% line.`;
}

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** Sessions → `[{ key, date, sessions }]` by local day, in start order. */
export function groupByDay(sessions) {
  const groups = new Map();
  const sorted = [...sessions].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  for (const session of sorted) {
    const date = new Date(session.startsAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = dayKey(date);
    if (!groups.has(key)) groups.set(key, { key, date, sessions: [] });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()];
}

/** "TODAY" / "TOMORROW" / "MON, 1 DEC". */
export function dayLabel(date, now) {
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dayKey(date) === dayKey(today)) return "TODAY";
  if (dayKey(date) === dayKey(tomorrow)) return "TOMORROW";
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
}

/** Session status for STATUS_COLORS.session (missed overrides scheduled). */
export const sessionStatus = (session) => {
  if (session?.status === "live" || session?.isLive) return "live";
  if (session?.status === "scheduled" && session?.isMissed) return "missed";
  return session?.status || "scheduled";
};

/** The class the tiles show: a live one first, else the next scheduled one not yet over. */
export function pickNextClass(sessions, now) {
  const open = sessions.filter((session) => session.status !== "cancelled" && session.status !== "ended" && new Date(session.endsAt).getTime() > now);
  return open.find((session) => sessionStatus(session) === "live") ?? open.find((session) => new Date(session.startsAt).getTime() > now) ?? open[0] ?? null;
}

// ─── Scan outcome copy ──────────────────────────────────────────────────────

/**
 * Error → `{ code, tone, title, message, joinCourse?, waitSeconds? }`.
 * tone: "info" (already marked), "warn" (retryable), "error".
 */
export function scanErrorView(error) {
  const code = error?.code || "ERROR";
  const fallback = () => {
    try {
      return attendanceErrorMessage(error) || error?.message || "Couldn't mark your attendance.";
    } catch {
      return error?.message || "Couldn't mark your attendance.";
    }
  };
  switch (code) {
    case "ALREADY_MARKED": {
      const status = error?.details?.status;
      return {
        code,
        tone: "info",
        title: "ALREADY MARKED",
        message: `Your attendance for this class is already recorded${status ? ` as ${String(status).toUpperCase()}` : ""}. Nothing else to do.`,
      };
    }
    case "TOKEN_EXPIRED":
      return {
        code,
        tone: "warn",
        title: "SCAN THE LIVE CODE AGAIN",
        message: "The QR changes after every scan and every few seconds. This one was already used or expired — scan the code on the screen again.",
      };
    case "SESSION_NOT_LIVE":
      return { code, tone: "error", title: "ATTENDANCE ISN'T OPEN", message: "Attendance for this class isn't open right now — it may have ended or not started yet. Ask your teacher." };
    case "NOT_ENROLLED":
      return {
        code,
        tone: "error",
        title: "NOT ENROLLED IN THIS COURSE",
        message: "You're not in this course yet. Ask your teacher for the 6-character join code, join, then scan again.",
        joinCourse: true,
      };
    case "DEVICE_ALREADY_USED":
      return {
        code,
        tone: "error",
        title: "THIS PHONE ALREADY MARKED A CLASSMATE",
        message: "Each phone can mark only one student per class. Scan with your own phone, or ask your teacher to mark you manually.",
      };
    case "OUT_OF_RANGE": {
      const distance = Number(error?.details?.distanceMeters);
      const allowed = Number(error?.details?.allowedMeters);
      const extra = Number.isFinite(distance) && Number.isFinite(allowed) ? ` (about ${distance} m away; allowed ${allowed} m)` : "";
      return { code, tone: "warn", title: "OUTSIDE THE CLASSROOM", message: `You seem to be outside the classroom${extra}. Move closer and scan again.` };
    }
    case "LOCATION_REQUIRED":
      return { code, tone: "warn", title: "LOCATION NEEDED", message: "This class needs your location. Allow location access and scan again." };
    case "LOCATION_UNAVAILABLE":
      return { code, tone: "warn", title: "LOCATION NEEDED", message: error?.message || "This class needs your location. Allow location access and scan again." };
    case "TOO_MANY_ATTEMPTS":
      return { code, tone: "warn", title: "TOO MANY ATTEMPTS", message: "Too many scans in a short time. Wait a minute, then scan again.", waitSeconds: 60 };
    case "INVALID_TOKEN":
      return { code, tone: "error", title: "NOT A VALID CODE", message: "This QR code isn't valid. Scan the code your teacher is showing." };
    case "NETWORK":
      return { code, tone: "warn", title: "NO CONNECTION", message: "Couldn't reach the server. Check your internet, then scan the live code again." };
    default:
      return { code, tone: "error", title: "COULDN'T MARK ATTENDANCE", message: fallback() };
  }
}
