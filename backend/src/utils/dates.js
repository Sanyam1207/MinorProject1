// Date helpers shared by the placements module (docs/contracts/PLACEMENTS.md §2.2).
//
// - Times are stored in UTC; the college zone is APP_TIMEZONE (default Asia/Kolkata).
// - Every service reads "now" from `clock.now()`. Tests pin it with `setClock(() => fixedDate)`
//   (or `setClock(fixedDate)`) and restore it with `resetClock()`.
// - `parseDateInput` accepts a Date, an ISO instant, a `YYYY-MM-DD` day (start or end of that
//   day in APP_TIMEZONE) or natural language ("next friday", "5 Dec 6pm") through chrono-node.
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/config.js";
import { fail } from "../core/http.js";

export const TIMEZONE = APP_TIMEZONE || "Asia/Kolkata";

const systemNow = () => new Date();
let nowSource = systemNow;

export const clock = Object.freeze({
    /** The current instant (a fresh Date each call). */
    now: () => {
        const value = nowSource();
        const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
        return Number.isNaN(date.getTime()) ? new Date() : date;
    },
});

/** Pin "now" for tests: `setClock(() => new Date(...))` or `setClock(new Date(...))`; null restores the system clock. */
export const setClock = (source) => {
    if (typeof source === "function") nowSource = source;
    else if (source instanceof Date || typeof source === "string" || typeof source === "number") {
        const fixed = new Date(source);
        nowSource = () => fixed;
    } else nowSource = systemNow;
};

export const resetClock = () => setClock(null);

const ISO_WITH_TIME = /T\d{2}:\d{2}/;
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (field) => fail(400, `${field} is not a valid date`, "VALIDATION", { field });

const dayBoundary = (dateTime, endOfDay) => (endOfDay ? dateTime.endOf("day") : dateTime.startOf("day")).toJSDate();

/** The APP_TIMEZONE offset (minutes) at `instant`. */
export const zoneOffsetMinutes = (instant = clock.now()) => DateTime.fromJSDate(instant).setZone(TIMEZONE).offset;

/**
 * Parse user/API date input.
 * @param {Date|string|number} value
 * @param {{endOfDay?: boolean, field?: string}} [options]
 * @returns {Date}
 * @throws 400 VALIDATION {field} when the value cannot be parsed
 */
export const parseDateInput = (value, { endOfDay = false, field = "date" } = {}) => {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw invalid(field);
        return new Date(value.getTime());
    }
    if (typeof value === "number") {
        const date = new Date(value);
        if (!Number.isFinite(value) || Number.isNaN(date.getTime())) throw invalid(field);
        return date;
    }
    if (typeof value !== "string") throw invalid(field);
    const text = value.trim();
    if (!text || text.length > 200) throw invalid(field);

    if (ISO_WITH_TIME.test(text)) {
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) throw invalid(field);
        return date;
    }

    const day = DAY_ONLY.exec(text);
    if (day) {
        const dateTime = DateTime.fromObject(
            { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) },
            { zone: TIMEZONE },
        );
        if (!dateTime.isValid) throw invalid(field);
        return dayBoundary(dateTime, endOfDay);
    }

    const instant = clock.now();
    const results = chrono.parse(text, { instant, timezone: zoneOffsetMinutes(instant) }, { forwardDate: true });
    const start = results[0]?.start;
    if (!start) throw invalid(field);
    if (!start.isCertain("hour")) {
        const dateTime = DateTime.fromObject(
            { year: start.get("year"), month: start.get("month"), day: start.get("day") },
            { zone: TIMEZONE },
        );
        if (!dateTime.isValid) throw invalid(field);
        return dayBoundary(dateTime, endOfDay);
    }
    const date = start.date();
    if (Number.isNaN(date.getTime())) throw invalid(field);
    return date;
};

const toZoned = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return DateTime.fromJSDate(date).setZone(TIMEZONE);
};

/** "5 Dec" in APP_TIMEZONE ("" for an empty or invalid value). */
export const formatDay = (value) => toZoned(value)?.toFormat("d LLL") ?? "";

/** "5 Dec 2026, 23:59" in APP_TIMEZONE ("" for an empty or invalid value). */
export const formatDateTime = (value) => toZoned(value)?.toFormat("d LLL yyyy, HH:mm") ?? "";

/** "2026-12-05" (the calendar day in APP_TIMEZONE), or null. */
export const dayKey = (value) => toZoned(value)?.toFormat("yyyy-LL-dd") ?? null;

/** Start of the APP_TIMEZONE day containing `value`. */
export const startOfDay = (value = clock.now()) => toZoned(value).startOf("day").toJSDate();

/** End (23:59:59.999) of the APP_TIMEZONE day containing `value`. */
export const endOfDay = (value = clock.now()) => toZoned(value).endOf("day").toJSDate();

/** `value` shifted by whole calendar days in APP_TIMEZONE. */
export const addDays = (value, days) => toZoned(value).plus({ days }).toJSDate();

/** ISO string or null. */
export const toIso = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
