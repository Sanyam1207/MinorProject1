// Date helpers for the teacher UI. Classes happen in the college time zone
// (Asia/Kolkata, UTC+05:30, no DST), whatever the browser's zone is, so every
// time shown or typed here is IST. Pure module (no DOM).
export const TIME_ZONE = "Asia/Kolkata";
const OFFSET_MINUTES = 330;
const DASH = "—";
const LOCALE = "en-IN";

export const WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

export const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const fmt = (value, options) => {
  const date = toDate(value);
  return date ? date.toLocaleString(LOCALE, { timeZone: TIME_ZONE, ...options }) : DASH;
};

export const istTime = (value) => fmt(value, { hour: "numeric", minute: "2-digit" });
export const istDate = (value) => fmt(value, { day: "numeric", month: "short", year: "numeric" });
export const istDateTime = (value) =>
  fmt(value, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const istDayHeading = (value) => fmt(value, { weekday: "long", day: "numeric", month: "short" });

/** "10:00 am – 11:00 am" */
export const istRange = (startsAt, endsAt) => `${istTime(startsAt)} – ${istTime(endsAt)}`;

/** Shift to "IST wall clock as UTC" so getUTC* read IST fields. */
const shifted = (date) => new Date(date.getTime() + OFFSET_MINUTES * 60_000);

/** "YYYY-MM-DD" of the IST calendar day of `value` (default now). */
export const istDayKey = (value = Date.now()) => {
  const date = toDate(value);
  return date ? shifted(date).toISOString().slice(0, 10) : "";
};

/** Add `days` to a "YYYY-MM-DD" key. */
export const addDays = (dayKey, days) => {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** IST weekday (0 = Sunday) of a "YYYY-MM-DD" key. */
export const weekdayOfKey = (dayKey) => {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** ISO instant → "YYYY-MM-DDTHH:mm" (IST) for <input type="datetime-local">. */
export const toIstInputValue = (value) => {
  const date = toDate(value);
  return date ? shifted(date).toISOString().slice(0, 16) : "";
};

/** "YYYY-MM-DDTHH:mm" read as IST → ISO string with +05:30 offset; null when invalid. */
export const fromIstInputValue = (text) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+05:30`;
};

/** Minutes between two instants (rounded). */
export const minutesBetween = (a, b) => {
  const start = toDate(a);
  const end = toDate(b);
  return start && end ? Math.round((end.getTime() - start.getTime()) / 60_000) : null;
};

/** Group sessions by IST day: [{ key, label, sessions }] in input order. */
export const groupByIstDay = (sessions = []) => {
  const groups = new Map();
  for (const session of sessions) {
    const key = istDayKey(session.startsAt);
    if (!groups.has(key)) groups.set(key, { key, label: istDayHeading(session.startsAt), sessions: [] });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()];
};

/** Display status of a session: "missed" for a scheduled class whose time is over. */
export const sessionStatus = (session, now) => {
  if (!session) return "scheduled";
  if (session.status === "scheduled") {
    const end = toDate(session.endsAt);
    if (session.isMissed || (end && now !== undefined && end.getTime() < now)) return "missed";
  }
  return session.status || "scheduled";
};

/** The backend lets a class start 30 min before startsAt until endsAt. */
export const START_EARLY_MINUTES = 30;
export const canStartNow = (session, now) => {
  if (!session || session.status !== "scheduled") return false;
  const start = toDate(session.startsAt);
  const end = toDate(session.endsAt);
  if (!start || !end) return false;
  return now >= start.getTime() - START_EARLY_MINUTES * 60_000 && now < end.getTime();
};
