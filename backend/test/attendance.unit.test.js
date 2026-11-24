// Pure helpers of the attendance module: percentage maths, time-zone parsing,
// fuzzy course matching, geo distance, device hashing.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";

const stats = await import("../src/modules/attendance/stats.js");
const time = await import("../src/modules/attendance/time.js");
const config = await import("../src/modules/attendance/config.js");
const { scoreCourse, normalise } = await import("../src/modules/attendance/resolve.js");
const { distanceMeters } = await import("../src/modules/attendance/scan.service.js");
const { serializeSession } = await import("../src/modules/attendance/serializers.js");

const ZONE = "Asia/Kolkata";
const local = (date) => DateTime.fromJSDate(date, { zone: ZONE });
// Wed 25 Nov 2026, 17:30 IST.
const NOW = new Date("2026-11-25T12:00:00Z");

describe("attendance percentages", () => {
    it("percent = attended / (held − excused), null when nothing counts", () => {
        assert.equal(stats.computePercent(3, 4, 0), 75);
        assert.equal(stats.computePercent(2, 4, 1), 66.7);
        assert.equal(stats.computePercent(0, 1, 1), null);
        assert.equal(stats.computePercent(0, 0, 0), null);
    });

    it("needToReach is the fewest consecutive classes that reach the threshold", () => {
        // 17/25 = 68 % → (17+n)/(25+n) ≥ 0.75 → n ≥ 7
        assert.equal(stats.computeNeedToReach(17, 25, 75), 7);
        assert.equal(stats.computeNeedToReach(3, 4, 75), 0);
        assert.equal(stats.computeNeedToReach(0, 1, 75), 3); // 3/4 = 75 %
        assert.equal(stats.computeNeedToReach(1, 2, 100), null); // unreachable
        assert.equal(stats.computeNeedToReach(0, 0, 75), 0);
    });

    it("canSkip is the most classes that can be missed while staying at the threshold", () => {
        // 9/10 → 9/(10+k) ≥ 0.75 → k ≤ 2
        assert.equal(stats.computeCanSkip(9, 10, 75), 2);
        assert.equal(stats.computeCanSkip(3, 4, 75), 0);
        assert.equal(stats.computeCanSkip(1, 2, 75), 0);
        assert.equal(stats.computeCanSkip(5, 5, 0), null);
    });

    it("status bands: safe ≥ t+5, warning ≥ t, critical < t, no-data", () => {
        assert.equal(stats.attendanceStatus(80, 75), "safe");
        assert.equal(stats.attendanceStatus(79.9, 75), "warning");
        assert.equal(stats.attendanceStatus(75, 75), "warning");
        assert.equal(stats.attendanceStatus(74.9, 75), "critical");
        assert.equal(stats.attendanceStatus(null, 75), "no-data");
    });

    it("summarise combines counts", () => {
        const summary = stats.summarise({ present: 5, late: 1, absent: 3, excused: 1 }, 75);
        assert.deepEqual(summary, {
            attended: 6, present: 5, late: 1, absent: 3, excused: 1, held: 10, percent: 66.7,
            status: "critical", needToReach: 3, canSkip: 0,
        });
        assert.equal(stats.summarise({ excused: 2 }, 75).percent, null);
        assert.equal(stats.summarise({ excused: 2 }, 75).status, "no-data");
    });
});

describe("college time zone parsing", () => {
    it("parses natural language in APP_TIMEZONE with forward dates", () => {
        const tomorrow = time.parseWhen("tomorrow 10am", { now: NOW });
        assert.equal(tomorrow.hasTime, true);
        assert.equal(tomorrow.date.toISOString(), "2026-11-26T04:30:00.000Z");
        const monday = time.parseWhen("next monday 2:30 pm", { now: NOW });
        assert.equal(local(monday.date).toFormat("ccc HH:mm"), "Mon 14:30");
        assert.ok(monday.date > NOW);
        // 3pm has passed today (17:30) → tomorrow.
        assert.equal(local(time.parseWhen("3pm", { now: NOW }).date).toISODate(), "2026-11-26");
    });

    it("keeps the base date when only a time is given", () => {
        const base = new Date("2026-11-28T04:30:00Z"); // Sat 10:00 IST
        const parsed = time.parseWhen("2pm", { now: NOW, baseDate: base });
        assert.equal(local(parsed.date).toFormat("yyyy-LL-dd HH:mm"), "2026-11-28 14:00");
        assert.equal(parsed.hasDate, false);
    });

    it("distinguishes day-only text and accepts ISO strings", () => {
        const tomorrow = time.parseWhen("tomorrow", { now: NOW });
        assert.equal(tomorrow.hasTime, false);
        assert.equal(tomorrow.dayStart.toISOString(), "2026-11-25T18:30:00.000Z");
        assert.equal(time.parseWhen("2026-12-01T09:00:00Z", { now: NOW }).date.toISOString(), "2026-12-01T09:00:00.000Z");
        // ISO without an offset is college time.
        assert.equal(time.parseWhen("2026-12-01T09:00", { now: NOW }).date.toISOString(), "2026-12-01T03:30:00.000Z");
        assert.equal(time.parseWhen("2026-12-01", { now: NOW }).hasTime, false);
        assert.equal(time.parseWhen("not a date at all", { now: NOW }), null);
    });

    it("parseDateInput enforces a time when required", () => {
        assert.throws(() => time.parseDateInput("tomorrow", { now: NOW, requireTime: true }), (error) => error.errors[0].code === "VALIDATION");
        assert.throws(() => time.parseDateInput("gibberish", { now: NOW }), (error) => error.statusCode === 400);
    });

    it("parses search windows", () => {
        const week = time.parseWindow("this week", { now: NOW });
        assert.equal(week.from.getTime(), NOW.getTime());
        assert.equal(local(week.to).toFormat("ccc HH:mm"), "Sun 23:59");
        const three = time.parseWindow("next 3 days", { now: NOW });
        assert.equal(Math.round((three.to - three.from) / 86_400_000), 3);
        const tomorrow = time.parseWindow("tomorrow", { now: NOW });
        assert.equal(local(tomorrow.from).toFormat("yyyy-LL-dd HH:mm"), "2026-11-26 00:00");
        const byFriday = time.parseWindow("by friday", { now: NOW });
        assert.equal(local(byFriday.to).toFormat("ccc"), "Fri");
        assert.equal(time.parseWindow("whenever", { now: NOW }), null);
    });

    it("rounds up to the 15-minute grid of the college clock", () => {
        assert.equal(local(time.ceilToGrid(new Date("2026-11-25T04:31:10Z"), 15)).toFormat("HH:mm"), "10:15");
        assert.equal(local(time.ceilToGrid(new Date("2026-11-25T04:30:00Z"), 15)).toFormat("HH:mm"), "10:00");
    });
});

describe("configuration helpers", () => {
    it("parses weekdays and clock times", () => {
        assert.equal(config.parseWeekday("mon"), 1);
        assert.equal(config.parseWeekday("Sunday"), 0);
        assert.equal(config.parseWeekday("6"), 6);
        assert.equal(config.parseWeekday(7), null);
        assert.equal(config.parseWeekday("funday"), null);
        assert.deepEqual(config.parseHHmm("9:05"), { hour: 9, minute: 5, minutes: 545, text: "09:05" });
        assert.equal(config.parseHHmm("25:00"), null);
    });

    it("reads working hours and days from the environment with safe defaults", () => {
        const saved = { start: process.env.WORK_DAY_START, end: process.env.WORK_DAY_END, days: process.env.WORK_DAYS };
        try {
            delete process.env.WORK_DAY_START;
            delete process.env.WORK_DAY_END;
            delete process.env.WORK_DAYS;
            assert.equal(config.workHours().start.text, "09:00");
            assert.equal(config.workHours().end.text, "17:00");
            assert.deepEqual(config.workDays(), [1, 2, 3, 4, 5, 6]);
            process.env.WORK_DAY_START = "18:00";
            process.env.WORK_DAY_END = "08:00";
            assert.equal(config.workHours().start.text, "09:00", "an inverted window falls back to the default");
            process.env.WORK_DAYS = "mon,wed,fri";
            assert.deepEqual(config.workDays(), [1, 3, 5]);
        } finally {
            for (const [key, value] of Object.entries({ WORK_DAY_START: saved.start, WORK_DAY_END: saved.end, WORK_DAYS: saved.days })) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it("hashes device ids with HMAC (never the raw id)", () => {
        const hash = config.hashDevice("device-123");
        assert.match(hash, /^[a-f0-9]{64}$/);
        assert.equal(hash, config.hashDevice("device-123"));
        assert.notEqual(hash, config.hashDevice("device-124"));
        assert.ok(!hash.includes("device"));
    });
});

describe("fuzzy course matching", () => {
    const dbms = { code: "CS301", name: "Database Management Systems", section: "A" };
    const cn = { code: "CS302", name: "Computer Networks" };
    const toc = { code: "CS303", name: "Theory of Computation" };

    it("scores code, name, initials and acronyms", () => {
        assert.equal(scoreCourse("cs301", dbms), 100);
        assert.equal(scoreCourse("CS-301", dbms), 100);
        assert.equal(scoreCourse("database management systems", dbms), 95);
        assert.equal(scoreCourse("cn", cn), 90);
        assert.equal(scoreCourse("my dbms class", dbms), 55);
        assert.ok(scoreCourse("networks", cn) >= 65);
        assert.ok(scoreCourse("theory of computation", toc) >= 65);
        assert.ok(scoreCourse("cs301 lecture tomorrow", dbms) >= 85);
        assert.equal(scoreCourse("physics", dbms), 0);
        assert.equal(scoreCourse("dbms", cn), 0);
    });

    it("normalises punctuation and accents", () => {
        assert.equal(normalise("  Théory & Practice!! "), "theory and practice");
    });
});

describe("misc", () => {
    it("computes great-circle distances", () => {
        const a = { lat: 28.6139, lng: 77.209 };
        assert.equal(Math.round(distanceMeters(a, a)), 0);
        const b = { lat: 28.6148, lng: 77.209 }; // ~100 m north
        assert.ok(Math.abs(distanceMeters(a, b) - 100) < 2);
    });

    it("flags sessions that never went live as missed", () => {
        const now = new Date("2026-11-25T12:00:00Z");
        const base = { _id: "64b000000000000000000001", course: "64b000000000000000000002", status: "scheduled", stats: {} };
        const past = serializeSession({ ...base, startsAt: new Date("2026-11-25T09:00:00Z"), endsAt: new Date("2026-11-25T10:00:00Z") }, { now });
        assert.equal(past.isMissed, true);
        assert.equal(past.durationMinutes, 60);
        const future = serializeSession({ ...base, startsAt: new Date("2026-11-25T13:00:00Z"), endsAt: new Date("2026-11-25T14:00:00Z") }, { now });
        assert.equal(future.isMissed, false);
        const ended = serializeSession({ ...base, status: "ended", startsAt: new Date("2026-11-25T09:00:00Z"), endsAt: new Date("2026-11-25T10:00:00Z") }, { now });
        assert.equal(ended.isMissed, false);
        assert.equal("qr" in past, false, "the QR state is never serialised with a session");
    });
});
