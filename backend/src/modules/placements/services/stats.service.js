// Placement analytics for the TPO dashboard and the placement_stats tool (docs/contracts/PLACEMENTS.md §6.5).
import { DateTime } from "luxon";
import { Job } from "../../../models/job.models.js";
import { User } from "../../../models/user.models.js";
import { APPLICATION_STATUSES, DRIVE_STATUSES, HELD_OFFER_STATUSES, OFFER_STATUSES } from "../constants.js";
import { Application } from "../models/application.model.js";
import { Offer } from "../models/offer.model.js";
import { TIMEZONE, clock } from "../utils/dates.js";
import { fail } from "../../../core/http.js";
import { str } from "../utils/input.js";
import { academicYearFor, academicYearMonths, academicYearRange, isValidAcademicYear } from "./academic-year.js";
import { branchLabel } from "./branches.js";
import { round2 } from "./package.js";
import { collegeScope } from "./scope.js";
import { idOf } from "./views.js";

const round1 = (value) => Math.round(value * 10) / 10;
const percent = (part, whole) => (whole > 0 ? round1((100 * part) / whole) : null);
const mean = (values) => (values.length ? round2(values.reduce((sum, value) => sum + value, 0) / values.length) : null);
const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return round2(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};
const max = (values) => (values.length ? round2(Math.max(...values)) : null);
const min = (values) => (values.length ? round2(Math.min(...values)) : null);
const zeroCounts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const monthOf = (date) => (date ? DateTime.fromJSDate(new Date(date)).setZone(TIMEZONE).toFormat("yyyy-LL") : null);

/**
 * GET /placements/stats.
 * @param {object} user tpo/admin
 * @param {{academicYear?, passingYear?, branch?, collegeId?}} query
 */
export const computeStats = async (user, query = {}) => {
    const academicYear = query.academicYear ? String(query.academicYear).trim() : academicYearFor(clock.now());
    if (!isValidAcademicYear(academicYear)) throw fail(400, "academicYear must look like 2026-27", "VALIDATION", { field: "academicYear" });
    const passingYear = str(query.passingYear, { field: "passingYear", max: 10 }) ?? null;
    const branch = str(query.branch, { field: "branch", max: 100 }) ?? null;
    const collegeId = user.role === "admin" ? (str(query.collegeId, { field: "collegeId", max: 24 }) ?? null) : null;
    const scope = collegeScope(user, { collegeId });

    const userFilter = { role: "student", isActive: { $ne: false }, ...scope };
    if (passingYear) userFilter.passingYear = passingYear;
    let students = await User.find(userFilter).select("branch").lean();
    if (branch) {
        const wanted = branchLabel(branch);
        students = students.filter((student) => branchLabel(student.branch) === wanted);
    }
    const studentIds = students.map((student) => student._id);
    const branchOf = new Map(students.map((student) => [String(student._id), branchLabel(student.branch)]));

    const [offers, applicationRows, driveRows] = await Promise.all([
        Offer.find({ student: { $in: studentIds }, academicYear }).select("student company companyName packageLpa status createdAt respondedAt").lean(),
        Application.aggregate([
            { $match: { student: { $in: studentIds }, academicYear } },
            { $group: { _id: "$status", n: { $sum: 1 } } },
        ]),
        (() => {
            const range = academicYearRange(academicYear);
            return Job.aggregate([
                { $match: { ...scope, createdAt: { $gte: range.start, $lt: range.end } } },
                { $group: { _id: { $ifNull: ["$status", "active"] }, n: { $sum: 1 } } },
            ]);
        })(),
    ]);

    // Best accepted/placed package per placed student (never counted twice).
    const best = new Map();
    for (const offer of offers) {
        if (!HELD_OFFER_STATUSES.includes(offer.status)) continue;
        const key = String(offer.student);
        best.set(key, Math.max(best.get(key) ?? 0, offer.packageLpa));
    }
    const packages = [...best.values()];

    const offersByStatus = zeroCounts(OFFER_STATUSES);
    for (const offer of offers) offersByStatus[offer.status] = (offersByStatus[offer.status] || 0) + 1;
    const applicationsByStatus = zeroCounts(APPLICATION_STATUSES);
    let applications = 0;
    for (const row of applicationRows) {
        applicationsByStatus[row._id] = row.n;
        applications += row.n;
    }
    const drives = { ...zeroCounts(DRIVE_STATUSES), total: 0 };
    for (const row of driveRows) {
        drives[row._id] = (drives[row._id] || 0) + row.n;
        drives.total += row.n;
    }

    const branchGroups = new Map();
    for (const student of students) {
        const label = branchOf.get(String(student._id));
        if (!branchGroups.has(label)) branchGroups.set(label, { branch: label, students: 0, packages: [] });
        const group = branchGroups.get(label);
        group.students += 1;
        const value = best.get(String(student._id));
        if (value !== undefined) group.packages.push(value);
    }
    const byBranch = [...branchGroups.values()]
        .map((group) => ({
            branch: group.branch,
            students: group.students,
            placedStudents: group.packages.length,
            placedPercent: percent(group.packages.length, group.students),
            avgLpa: mean(group.packages),
            medianLpa: median(group.packages),
            maxLpa: max(group.packages),
        }))
        .sort((a, b) => b.students - a.students || a.branch.localeCompare(b.branch));

    const companies = new Map();
    for (const offer of offers) {
        const key = offer.company ? `id:${offer.company}` : `name:${String(offer.companyName || "").toLowerCase()}`;
        if (!companies.has(key)) {
            companies.set(key, { companyId: offer.company ? idOf(offer.company) : null, companyName: offer.companyName, offers: 0, accepted: 0, acceptedPackages: [], all: [] });
        }
        const entry = companies.get(key);
        entry.offers += 1;
        entry.all.push(offer.packageLpa);
        if (HELD_OFFER_STATUSES.includes(offer.status)) {
            entry.accepted += 1;
            entry.acceptedPackages.push(offer.packageLpa);
        }
    }
    const topCompanies = [...companies.values()]
        .map((entry) => ({
            companyId: entry.companyId,
            companyName: entry.companyName,
            offers: entry.offers,
            accepted: entry.accepted,
            avgLpa: mean(entry.acceptedPackages),
            maxLpa: max(entry.all),
        }))
        .sort((a, b) => b.accepted - a.accepted || b.offers - a.offers || (b.maxLpa ?? 0) - (a.maxLpa ?? 0))
        .slice(0, 10);

    const monthly = academicYearMonths(academicYear).map((month) => ({ month, offers: 0, accepted: 0 }));
    const monthIndex = new Map(monthly.map((entry, index) => [entry.month, index]));
    for (const offer of offers) {
        const created = monthIndex.get(monthOf(offer.createdAt));
        if (created !== undefined) monthly[created].offers += 1;
        if (HELD_OFFER_STATUSES.includes(offer.status)) {
            const acceptedMonth = monthIndex.get(monthOf(offer.respondedAt || offer.createdAt));
            if (acceptedMonth !== undefined) monthly[acceptedMonth].accepted += 1;
        }
    }

    const placedStudents = best.size;
    return {
        academicYear,
        generatedAt: clock.now().toISOString(),
        filters: { passingYear, branch, collegeId },
        totals: {
            students: students.length,
            placedStudents,
            placedPercent: percent(placedStudents, students.length),
            unplacedStudents: Math.max(0, students.length - placedStudents),
            applications,
            offers: offers.length,
            drives,
        },
        packages: { count: packages.length, avgLpa: mean(packages), medianLpa: median(packages), maxLpa: max(packages), minLpa: min(packages) },
        offersByStatus,
        applicationsByStatus,
        byBranch,
        topCompanies,
        monthly,
    };
};
