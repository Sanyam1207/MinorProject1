// Academic years (docs/contracts/PLACEMENTS.md §2.3), e.g. "2026-27" = 1 Jul 2026 → 1 Jul 2027 (local time).
import { DateTime } from "luxon";
import { placementsConfig } from "../config.js";
import { TIMEZONE, clock } from "../utils/dates.js";

const YEAR_RE = /^(\d{4})-(\d{2})$/;

const startMonth = () => placementsConfig.academicYearStartMonth;

/** "2026-27" for any instant inside that academic year (APP_TIMEZONE). */
export const academicYearFor = (date = clock.now()) => {
    const value = date instanceof Date ? date : new Date(date ?? clock.now());
    const local = DateTime.fromJSDate(Number.isNaN(value.getTime()) ? clock.now() : value).setZone(TIMEZONE);
    const start = local.month >= startMonth() ? local.year : local.year - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};

export const isValidAcademicYear = (value) => {
    if (typeof value !== "string") return false;
    const match = YEAR_RE.exec(value.trim());
    if (!match) return false;
    return Number(match[2]) === (Number(match[1]) + 1) % 100;
};

/** `{start, end}` (end exclusive) of an academic year in local time. */
export const academicYearRange = (academicYear) => {
    if (!isValidAcademicYear(academicYear)) throw new RangeError(`Invalid academic year "${academicYear}"`);
    const first = Number(academicYear.slice(0, 4));
    const start = DateTime.fromObject({ year: first, month: startMonth(), day: 1 }, { zone: TIMEZONE }).startOf("day");
    return { start: start.toJSDate(), end: start.plus({ years: 1 }).toJSDate() };
};

/** The 12 "YYYY-MM" month keys of an academic year, in order. */
export const academicYearMonths = (academicYear) => {
    const { start } = academicYearRange(academicYear);
    const first = DateTime.fromJSDate(start).setZone(TIMEZONE);
    return Array.from({ length: 12 }, (_, index) => first.plus({ months: index }).toFormat("yyyy-LL"));
};
