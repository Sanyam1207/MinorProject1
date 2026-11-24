// Environment for the placements module (docs/contracts/PLACEMENTS.md §13), read once at import.
// The object is mutable on purpose: tests flip individual settings (e.g. companyAutoApprove).
import "../../config/config.js"; // loads ./.env before the variables below are read

const intEnv = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const numEnv = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

export const placementsConfig = {
    /** First month (1–12) of the academic year in APP_TIMEZONE. */
    academicYearStartMonth: intEnv("ACADEMIC_YEAR_START_MONTH", 7, { min: 1, max: 12 }),
    /** Interval of the placements.sweep background job. */
    sweepIntervalMs: intEnv("PLACEMENT_SWEEP_INTERVAL_MS", 300_000, { min: 30_000 }),
    /** Remind students this many hours before an offer expires (0 = off). */
    offerReminderHours: numEnv("OFFER_REMINDER_HOURS", 24, { min: 0, max: 24 * 30 }),
    /** Remind eligible students who have not applied this many hours before a deadline (0 = off). */
    driveDeadlineReminderHours: numEnv("DRIVE_DEADLINE_REMINDER_HOURS", 24, { min: 0, max: 24 * 30 }),
    /** Company drives skip TPO review and are published immediately. */
    companyAutoApprove: String(process.env.PLACEMENT_COMPANY_AUTO_APPROVE || "false").trim().toLowerCase() === "true",
    /** Cap on the audience of a single announcement. */
    announceMaxRecipients: intEnv("PLACEMENT_ANNOUNCE_MAX_RECIPIENTS", 5000, { min: 1 }),
};

export default placementsConfig;
