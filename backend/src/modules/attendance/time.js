// College time-zone helpers (luxon) and natural-language date parsing (chrono-node).
// Everything is stored in UTC; APP_TIMEZONE is used for wall-clock maths:
// timetables, working hours, "tomorrow 10am", day ranges and display strings.
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { fail } from "../../core/http.js";
import { timezone } from "./config.js";

let cachedZone = null;
let cachedZoneSource = null;

/** The college IANA zone (falls back to Asia/Kolkata when APP_TIMEZONE is invalid). */
export const zone = () => {
    const configured = timezone();
    if (configured !== cachedZoneSource) {
        cachedZoneSource = configured;
        cachedZone = DateTime.now().setZone(configured).isValid ? configured : "Asia/Kolkata";
    }
    return cachedZone;
};

export const toLocal = (date) => DateTime.fromJSDate(date instanceof Date ? date : new Date(date), { zone: zone() });

export const formatDay = (date) => toLocal(date).toFormat("ccc d LLL");
export const formatTime = (date) => toLocal(date).toFormat("HH:mm");
export const formatDateTime = (date) => toLocal(date).toFormat("yyyy-LL-dd HH:mm");
export const formatDate = (date) => toLocal(date).toFormat("yyyy-LL-dd");
/** "Tue 25 Nov, 10:00–11:00" */
export const formatSlot = (start, end) => `${formatDay(start)}, ${formatTime(start)}–${formatTime(end)}`;

export const localDayRange = (date) => {
    const local = toLocal(date);
    return { start: local.startOf("day").toJSDate(), end: local.endOf("day").toJSDate() };
};

/** Luxon weekday (1=Mon … 7=Sun) → contract weekday (0=Sun … 6=Sat). */
export const contractWeekday = (dateTime) => dateTime.weekday % 7;

/** Round `date` up to the next `stepMinutes` boundary of the college wall clock. */
export const ceilToGrid = (date, stepMinutes) => {
    const local = toLocal(date);
    const floored = local.startOf("minute");
    const minutesOfDay = floored.hour * 60 + floored.minute;
    const remainder = minutesOfDay % stepMinutes;
    const needsBump = remainder !== 0 || local.second > 0 || local.millisecond > 0;
    if (!needsBump) return floored.toJSDate();
    return floored.plus({ minutes: remainder === 0 ? stepMinutes : stepMinutes - remainder }).toJSDate();
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const describe = (dateTime, { hasTime, hasDate, text }) => ({
    date: dateTime.toJSDate(),
    hasTime,
    hasDate,
    text,
    dayStart: dateTime.startOf("day").toJSDate(),
    dayEnd: dateTime.endOf("day").toJSDate(),
});

/**
 * Parse an ISO string or natural language ("tomorrow 10am", "next monday 2:30 pm") in the college zone.
 * @param {string|Date} input
 * @param {{now?: Date, baseDate?: Date|null, forward?: boolean}} options
 *   baseDate: day used when the text names only a time ("2pm" while rescheduling keeps the class's day)
 *   forward:  prefer future dates for ambiguous text (chrono forwardDate)
 * @returns {{date: Date, hasTime: boolean, hasDate: boolean, text: string, dayStart: Date, dayEnd: Date} | null}
 */
export const parseWhen = (input, { now = new Date(), baseDate = null, forward = true } = {}) => {
    if (input instanceof Date) {
        if (Number.isNaN(input.getTime())) return null;
        return describe(toLocal(input), { hasTime: true, hasDate: true, text: input.toISOString() });
    }
    const text = String(input ?? "").trim();
    if (!text) return null;
    if (ISO_DATE_RE.test(text)) {
        const day = DateTime.fromISO(text, { zone: zone() });
        return day.isValid ? describe(day.startOf("day"), { hasTime: false, hasDate: true, text }) : null;
    }
    if (ISO_DATETIME_RE.test(text)) {
        const parsed = DateTime.fromISO(text.replace(" ", "T"), { zone: zone() });
        return parsed.isValid ? describe(parsed.setZone(zone()), { hasTime: true, hasDate: true, text }) : null;
    }

    const reference = { instant: now, timezone: toLocal(now).offset };
    const [result] = chrono.parse(text, reference, { forwardDate: forward });
    if (!result) return null;
    const start = result.start;
    const hasTime = start.isCertain("hour");
    const hasDate = start.isCertain("day") || start.isCertain("weekday") || start.isCertain("month") || start.isCertain("year");
    let dateTime;
    if (start.isCertain("timezoneOffset")) {
        // Explicit zone or relative time ("in 2 hours", "10am UTC"): chrono's instant is exact.
        dateTime = toLocal(start.date());
    } else {
        let { year, month, day } = { year: start.get("year"), month: start.get("month"), day: start.get("day") };
        if (!hasDate && baseDate) {
            const base = toLocal(baseDate);
            ({ year, month, day } = base);
        }
        dateTime = DateTime.fromObject({
            year,
            month,
            day,
            hour: hasTime ? start.get("hour") : 0,
            minute: hasTime ? (start.get("minute") ?? 0) : 0,
        }, { zone: zone() });
    }
    if (!dateTime.isValid) return null;
    return describe(dateTime, { hasTime, hasDate, text: result.text });
};

/**
 * A date input from a REST body or tool argument; throws 400 VALIDATION when it cannot be parsed.
 * `requireTime` rejects day-only values ("tomorrow") where a start time is needed.
 */
export const parseDateInput = (value, { field = "when", now = new Date(), baseDate = null, requireTime = false, forward = true } = {}) => {
    const parsed = parseWhen(value, { now, baseDate, forward });
    if (!parsed) {
        throw fail(400, `Could not understand the ${field} "${String(value ?? "").slice(0, 80)}". Try "tomorrow 10am" or an ISO date.`, "VALIDATION", { field });
    }
    if (requireTime && !parsed.hasTime) {
        throw fail(400, `Please include a time for ${field}, e.g. "tomorrow 10am".`, "VALIDATION", { field });
    }
    return parsed;
};

/**
 * A search window such as "this week", "next 3 days", "tomorrow", "next week" or "by friday".
 * @returns {{from: Date, to: Date, label: string} | null}
 */
export const parseWindow = (text, { now = new Date() } = {}) => {
    const value = String(text ?? "").trim().toLowerCase();
    if (!value) return null;
    const local = toLocal(now);
    const numberWords = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };
    const toNumber = (token) => (/^\d+$/.test(token) ? Number(token) : numberWords[token] ?? null);

    if (/\btoday\b/.test(value)) return { from: now, to: local.endOf("day").toJSDate(), label: "today" };
    if (/\btomorrow\b/.test(value)) {
        const day = local.plus({ days: 1 });
        return { from: day.startOf("day").toJSDate(), to: day.endOf("day").toJSDate(), label: "tomorrow" };
    }
    if (/\bnext week\b/.test(value)) {
        const week = local.plus({ weeks: 1 });
        return { from: week.startOf("week").toJSDate(), to: week.endOf("week").toJSDate(), label: "next week" };
    }
    if (/\b(this|current) week\b|\bweek\b$/.test(value) && !/\d|\bnext\b/.test(value)) {
        return { from: now, to: local.endOf("week").toJSDate(), label: "this week" };
    }
    const span = /(?:next|within|in|over the next|coming)?\s*(\d+|a|an|one|two|three|four|five|six|seven|ten|fourteen)\s+(day|days|week|weeks|hour|hours)\b/.exec(value);
    if (span) {
        const amount = toNumber(span[1]);
        if (amount && amount > 0) {
            const unit = span[2].startsWith("week") ? "weeks" : span[2].startsWith("hour") ? "hours" : "days";
            const capped = Math.min(amount, unit === "weeks" ? 8 : unit === "days" ? 60 : 24 * 60);
            return { from: now, to: local.plus({ [unit]: capped }).toJSDate(), label: `next ${capped} ${unit}` };
        }
    }
    if (/\bthis month\b/.test(value)) return { from: now, to: local.endOf("month").toJSDate(), label: "this month" };

    // "by friday" / "before monday" → up to the end of that day; "on monday" / "monday" → that day.
    const until = /\b(by|before|until|till)\b/.test(value);
    const parsed = parseWhen(value.replace(/\b(by|before|until|till|on|within)\b/g, " ").trim(), { now });
    if (!parsed || !parsed.hasDate) return null;
    if (until) return { from: now, to: parsed.dayEnd, label: `until ${formatDay(parsed.date)}` };
    const from = parsed.dayStart > now ? parsed.dayStart : now;
    return { from, to: parsed.dayEnd, label: formatDay(parsed.date) };
};
