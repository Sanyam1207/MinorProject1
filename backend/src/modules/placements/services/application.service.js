// Applications: apply, withdraw, the staff pipeline, bulk changes, CSV export, resume links and
// the offer → application sync (docs/contracts/PLACEMENTS.md §6.2, §7.2, §7.4).
import mongoose from "mongoose";
import { assertObjectId, escapeRegex, fail, intParam, isObjectId } from "../../../core/http.js";
import { Job } from "../../../models/job.models.js";
import { Resume } from "../../../models/resume.models.js";
import { User } from "../../../models/user.models.js";
import {
    APPLICATION_STATUSES,
    LIVE_APPLICATION_STATUSES,
    PIPELINE_ORDER,
    isStaff,
    statusLabel,
    transitionError,
} from "../constants.js";
import { Application } from "../models/application.model.js";
import { MAX_CSV_ROWS, slug, toCsv } from "../utils/csv.js";
import { clock, formatDateTime } from "../utils/dates.js";
import { bool, enumList, oneOf, str } from "../utils/input.js";
import { academicYearFor } from "./academic-year.js";
import { branchMatches } from "./branches.js";
import { buildStaffJobViews } from "./drive.service.js";
import { evaluateForJob, studentFacts } from "./eligibility.service.js";
import * as events from "./events.js";
import { withLock } from "./locks.js";
import { formatLpa } from "./package.js";
import { andFilters, applicationScope, collegeScope, notFound, resolveJobScope } from "./scope.js";
import {
    emptyApplicationCounts,
    idOf,
    toApplicationStaffView,
    toApplicationStudentView,
} from "./views.js";

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

const JOB_FIELDS = "title company college salary packageLpa packageMaxLpa location applicationDeadline driveDate status";
export const STUDENT_POPULATE = [
    { path: "job", select: JOB_FIELDS, populate: { path: "company", select: "name" } },
    { path: "offer", select: "status packageLpa" },
];
export const STAFF_POPULATE = [
    { path: "job", select: JOB_FIELDS, populate: { path: "company", select: "name" } },
    { path: "student", select: "name email rollNumber ggsipuEnrollment branch section semester passingYear cgpa activeBacklogs skills college" },
    { path: "offer", select: "status packageLpa" },
];

const roleOf = (user) => (user.role === "admin" ? "admin" : user.role);
const timelineEntry = (status, user, note = "") => ({
    status,
    at: clock.now(),
    by: user?._id ?? null,
    byRole: user ? roleOf(user) : "system",
    byName: user?.name || (user ? "" : "System"),
    note: String(note || "").slice(0, 500),
});

/** The view matching the caller (owner student or staff/company). */
export const viewApplicationFor = (user, application) => (user.role === "student"
    ? toApplicationStudentView(application)
    : toApplicationStaffView(application, { viewer: user }));

const loadStudentView = async (applicationId) => toApplicationStudentView(
    await Application.findById(applicationId).populate(STUDENT_POPULATE).lean(),
);

const loadStaffView = async (applicationId, viewer) => toApplicationStaffView(
    await Application.findById(applicationId).populate(STAFF_POPULATE).lean(),
    { viewer },
);

/** Socket events for an application (student view to the owner, a minimal payload to staff). */
export const emitApplicationChange = async (application, action = "updated") => {
    try {
        const view = await loadStudentView(application._id);
        events.applicationChanged(application, view, action);
    } catch (error) {
        if (process.env.NODE_ENV !== "test") console.error("[placements] application socket emit failed:", error?.message || error);
    }
};

// ── Resumes (resume-bank / resume-lab) ──────────────────────────────────────

let resumeBankPromise = null;
const resumeBank = () => {
    resumeBankPromise ||= import("../../../services/resume-bank.service.js").catch((error) => {
        if (process.env.NODE_ENV !== "test") console.error("[placements] resume-bank service unavailable:", error?.message || error);
        return {};
    });
    return resumeBankPromise;
};

/**
 * The resume attached to an application: `resumeId` must be an active resume of the student;
 * without it the student's primary (else latest active) resume is used, if any.
 * @returns {Promise<{id, title, version}|null>}
 */
export const resolveStudentResume = async (studentId, resumeId) => {
    if (resumeId !== undefined && resumeId !== null && resumeId !== "") {
        if (!isObjectId(String(resumeId))) throw fail(400, "resumeId must be a valid id", "VALIDATION", { field: "resumeId" });
        const resume = await Resume.findOne({ _id: toObjectId(resumeId), owner: studentId, status: "active" }).select("title version").lean();
        if (!resume) throw fail(404, "That resume was not found among your active resumes", "RESUME_NOT_FOUND");
        return { id: resume._id, title: resume.title || "", version: resume.version ?? null };
    }
    let resume = null;
    const bank = await resumeBank();
    if (typeof bank.getPrimaryResume === "function") {
        try {
            resume = await bank.getPrimaryResume(studentId);
        } catch {
            resume = null;
        }
        if (resume && resume.status && resume.status !== "active") resume = null;
    }
    if (!resume) {
        resume = await Resume.findOne({ owner: studentId, status: "active" }).sort({ version: -1 }).select("title version").lean();
    }
    return resume ? { id: resume._id, title: resume.title || "", version: resume.version ?? null } : null;
};

const lockAppliedResume = async (resumeId) => {
    if (!resumeId) return;
    const bank = await resumeBank();
    if (typeof bank.lockResume !== "function") return;
    try {
        await bank.lockResume(resumeId, "application");
    } catch (error) {
        if (process.env.NODE_ENV !== "test") console.error("[placements] could not lock the applied resume:", error?.message || error);
    }
};

// ── Apply (§7.2) ────────────────────────────────────────────────────────────

const eligibilityError = (eligibility) => {
    if (eligibility.status === "incomplete") {
        return fail(422, eligibility.reasons[0] || "Complete your profile to check eligibility", "PROFILE_INCOMPLETE", { missing: eligibility.missing });
    }
    if (eligibility.code === "POLICY_BLOCKED") {
        return fail(403, eligibility.reasons[0] || "The one-offer policy blocks this application", "POLICY_BLOCKED", {
            reasons: eligibility.reasons,
            currentAcceptedPackage: eligibility.policy.currentAcceptedPackage,
            requiredPackageLpa: eligibility.policy.requiredPackageLpa,
        });
    }
    return fail(403, eligibility.reasons[0] || "You are not eligible for this drive", "NOT_ELIGIBLE", { reasons: eligibility.reasons });
};

const buildSnapshot = (eligibility, facts, { status } = {}) => ({
    eligible: eligibility ? eligibility.eligible : null,
    status: status || eligibility?.status || "unknown",
    code: eligibility?.code ?? null,
    reasons: eligibility?.reasons ?? [],
    missing: eligibility?.missing ?? [],
    checks: eligibility?.checks ?? [],
    policy: eligibility?.policy ?? undefined,
    profile: {
        cgpa: facts.cgpa,
        activeBacklogs: facts.activeBacklogs,
        branch: facts.branch,
        passingYear: facts.passingYear,
        tenthPercentage: facts.tenthPercentage,
        twelfthPercentage: facts.twelfthPercentage,
        verified: facts.verified,
    },
    evaluatedAt: clock.now(),
});

const alreadyApplied = (existing) => fail(
    409,
    existing.status === "rejected" ? "Your earlier application to this drive was not selected" : "You have already applied to this drive",
    "ALREADY_APPLIED",
    { applicationId: idOf(existing._id), status: existing.status },
);

/**
 * Every read-only apply check, in contract order. Used by apply and by the drive_apply preview.
 * @returns {Promise<{job, existing, eligibility, resume}>}
 */
export const checkApply = async (user, jobId, { resumeId } = {}) => {
    if (user.role !== "student") throw fail(403, "Only students can apply to drives", "FORBIDDEN");
    assertObjectId(String(jobId ?? ""), "jobId");
    const scope = await resolveJobScope(user);
    const job = await Job.findOne(andFilters({ _id: toObjectId(jobId) }, scope)).populate("company", "name").lean();
    if (!job) throw notFound("Drive");
    if ((job.status || "active") !== "active") throw fail(409, "This drive is not open for applications", "DRIVE_NOT_OPEN");
    if (job.applicationDeadline && new Date(job.applicationDeadline).getTime() <= clock.now().getTime()) {
        throw fail(409, "The application deadline for this drive has passed", "DEADLINE_PASSED");
    }
    const existing = await Application.findOne({ job: job._id, student: user._id }).lean();
    if (existing && existing.status !== "withdrawn") throw alreadyApplied(existing);
    const eligibility = await evaluateForJob(user, job);
    if (!eligibility.eligible) throw eligibilityError(eligibility);
    const resume = await resolveStudentResume(user._id, resumeId);
    return { job, existing, eligibility, resume };
};

/**
 * POST /jobs/:id/apply and tool drive_apply.
 * @returns {Promise<{application: object, created: boolean}>} ApplicationStudentView
 */
export const applyToDrive = async (user, jobId, { resumeId, coverNote, source = "web" } = {}) => {
    const note = str(coverNote, { field: "coverNote", max: 2000 }) ?? "";
    return withLock(`apply:${user._id}:${jobId}`, async () => {
        const { job, existing, eligibility, resume } = await checkApply(user, jobId, { resumeId });
        const now = clock.now();
        const snapshot = buildSnapshot(eligibility, studentFacts(user));
        const entry = timelineEntry("applied", user);
        let application;
        if (existing) {
            application = await Application.findOneAndUpdate(
                { _id: existing._id, status: "withdrawn" },
                {
                    $set: {
                        status: "applied",
                        appliedAt: now,
                        withdrawnAt: null,
                        decidedAt: null,
                        eligibilitySnapshot: snapshot,
                        eligibilityOverride: null,
                        resume,
                        coverNote: note,
                        source,
                        academicYear: academicYearFor(now),
                    },
                    $push: { timeline: entry },
                },
                { returnDocument: "after", runValidators: true },
            ).lean();
            if (!application) throw fail(409, "You have already applied to this drive", "ALREADY_APPLIED");
        } else {
            try {
                application = (await Application.create({
                    job: job._id,
                    student: user._id,
                    college: job.college ?? user.college ?? null,
                    company: job.company?._id ?? job.company,
                    academicYear: academicYearFor(now),
                    status: "applied",
                    timeline: [entry],
                    resume,
                    coverNote: note,
                    eligibilitySnapshot: snapshot,
                    source,
                    appliedAt: now,
                })).toObject();
            } catch (error) {
                if (error?.code === 11000) throw fail(409, "You have already applied to this drive", "ALREADY_APPLIED");
                throw error;
            }
        }
        await lockAppliedResume(resume?.id);
        const view = await loadStudentView(application._id);
        events.applicationChanged(application, view, existing ? "updated" : "created");
        events.applicationCreated(application, job, user);
        return { application: view, created: !existing };
    });
};

// ── Student reads and withdraw ──────────────────────────────────────────────

/** GET /applications/my */
export const listMyApplications = async (user, { status } = {}) => {
    const statuses = enumList(status, APPLICATION_STATUSES, { field: "status" });
    const filter = { student: user._id };
    if (statuses) filter.status = { $in: statuses };
    const rows = await Application.find(filter).populate(STUDENT_POPULATE).sort({ appliedAt: -1 }).limit(500).lean();
    return rows.map(toApplicationStudentView);
};

/** An application in the caller's scope (404 otherwise). */
export const loadApplicationInScope = async (user, applicationId, { populate = STAFF_POPULATE } = {}) => {
    assertObjectId(String(applicationId ?? ""), "applicationId");
    const scope = applicationScope(user);
    const application = await Application.findOne(andFilters({ _id: toObjectId(applicationId) }, scope)).populate(populate).lean();
    if (!application) throw notFound("Application");
    return application;
};

/** GET /applications/:id */
export const getApplication = async (user, applicationId) => viewApplicationFor(
    user,
    await loadApplicationInScope(user, applicationId, { populate: user.role === "student" ? STUDENT_POPULATE : STAFF_POPULATE }),
);

/** Read-only withdraw check (tool preview). */
export const checkWithdraw = (application) => {
    if (application.status === "offered") throw fail(409, "You have a pending offer for this application. Reject the offer instead.", "OFFER_PENDING");
    if (!LIVE_APPLICATION_STATUSES.includes(application.status)) {
        throw fail(409, `An application that is ${statusLabel(application.status).toLowerCase()} cannot be withdrawn`, "INVALID_TRANSITION");
    }
};

/** POST /applications/:id/withdraw (owner student). */
export const withdrawApplication = async (user, applicationId, { reason } = {}) => {
    if (user.role !== "student") throw fail(403, "Only the student can withdraw an application", "FORBIDDEN");
    const note = str(reason, { field: "reason", max: 500 }) ?? "";
    const application = await loadApplicationInScope(user, applicationId, { populate: STUDENT_POPULATE });
    checkWithdraw(application);
    const updated = await Application.findOneAndUpdate(
        { _id: application._id, status: application.status },
        { $set: { status: "withdrawn", withdrawnAt: clock.now() }, $push: { timeline: timelineEntry("withdrawn", user, note) } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) throw fail(409, "The application changed while it was being withdrawn; reload and try again", "INVALID_TRANSITION");
    const view = await loadStudentView(updated._id);
    events.applicationChanged(updated, view, "withdrawn");
    return { application: view };
};

// ── Staff pipeline ──────────────────────────────────────────────────────────

/** Read-only status-change check (tool preview). Returns the target or throws. */
export const checkStatusChange = (application, status, user) => {
    const error = transitionError(application.status, status, user.role);
    if (error) throw error;
};

const applyStatusChange = async (user, application, status, note) => {
    checkStatusChange(application, status, user);
    if (application.status === status) return { application, changed: false };
    const now = clock.now();
    const updated = await Application.findOneAndUpdate(
        { _id: application._id, status: application.status },
        {
            $set: { status, decidedAt: status === "rejected" ? now : null, withdrawnAt: null },
            $push: { timeline: timelineEntry(status, user, note) },
        },
        { returnDocument: "after" },
    ).populate(STAFF_POPULATE).lean();
    if (!updated) throw fail(409, "The application changed while it was being updated; reload and try again", "INVALID_TRANSITION");
    await events.applicationStatusToStudent(updated, updated.job || { title: "your drive" }, { note });
    await emitApplicationChange(updated, "updated");
    return { application: updated, changed: true };
};

const staffOnly = (user) => {
    if (!isStaff(user) && user.role !== "company") throw fail(403, "Only the placement office and recruiters can change applications", "FORBIDDEN");
};

/** PATCH /applications/:id/status */
export const changeApplicationStatus = async (user, applicationId, { status, note } = {}) => {
    staffOnly(user);
    const target = oneOf(status, APPLICATION_STATUSES, { field: "status", required: true });
    const cleanNote = str(note, { field: "note", max: 500 }) ?? "";
    const application = await loadApplicationInScope(user, applicationId);
    const result = await applyStatusChange(user, application, target, cleanNote);
    return { application: toApplicationStaffView(result.application, { viewer: user }), changed: result.changed };
};

/** POST /applications/bulk-status → {updated, unchanged, failed:[{id, code, message}]} */
export const bulkChangeStatus = async (user, { applicationIds, status, note } = {}) => {
    staffOnly(user);
    if (!Array.isArray(applicationIds) || applicationIds.length < 1 || applicationIds.length > 500) {
        throw fail(400, "applicationIds must list between 1 and 500 ids", "VALIDATION", { field: "applicationIds" });
    }
    const target = oneOf(status, APPLICATION_STATUSES, { field: "status", required: true });
    const cleanNote = str(note, { field: "note", max: 500 }) ?? "";
    const result = { updated: 0, unchanged: 0, failed: [] };
    const seen = new Set();
    for (const rawId of applicationIds) {
        const id = String(rawId ?? "");
        if (seen.has(id)) continue;
        seen.add(id);
        try {
            if (!isObjectId(id)) throw fail(400, "Invalid application id", "VALIDATION", { field: "applicationIds" });
            const application = await loadApplicationInScope(user, id);
            const outcome = await applyStatusChange(user, application, target, cleanNote);
            if (outcome.changed) result.updated += 1;
            else result.unchanged += 1;
        } catch (error) {
            const code = error?.errors?.[0]?.code || "ERROR";
            if (!error?.statusCode || error.statusCode >= 500) {
                if (process.env.NODE_ENV !== "test") console.error("[placements] bulk status failed:", error);
            }
            result.failed.push({ id, code, message: error?.statusCode && error.statusCode < 500 ? error.message : "Could not update" });
        }
    }
    return result;
};

/** POST /applications (tpo): add a student on their behalf, optionally overriding eligibility. */
export const staffAddApplicant = async (user, { jobId, studentId, note, overrideEligibility, resumeId } = {}) => {
    if (!isStaff(user)) throw fail(403, "Only the placement office can add applicants", "FORBIDDEN");
    assertObjectId(String(jobId ?? ""), "jobId");
    assertObjectId(String(studentId ?? ""), "studentId");
    const override = bool(overrideEligibility);
    const cleanNote = str(note, { field: "note", max: 500 }) ?? "";

    const student = await User.findOne(andFilters({ _id: toObjectId(studentId), role: "student" }, collegeScope(user)));
    if (!student) throw notFound("Student");
    const job = await Job.findOne(andFilters({ _id: toObjectId(jobId) }, await resolveJobScope(user))).populate("company", "name").lean();
    if (!job) throw notFound("Drive");
    if (!["active", "closed"].includes(job.status || "active")) throw fail(409, "Applicants can be added only to published or closed drives", "DRIVE_NOT_OPEN");

    return withLock(`apply:${student._id}:${job._id}`, async () => {
        const existing = await Application.findOne({ job: job._id, student: student._id }).lean();
        if (existing && existing.status !== "withdrawn") throw alreadyApplied(existing);
        const eligibility = await evaluateForJob(student, job);
        if (!eligibility.eligible && !override) throw eligibilityError(eligibility);
        if (!eligibility.eligible && cleanNote.length < 3) {
            throw fail(400, "Add a note (3–500 characters) explaining the eligibility override", "VALIDATION", { field: "note" });
        }
        const resume = await resolveStudentResume(student._id, resumeId);
        const now = clock.now();
        const overriding = !eligibility.eligible && override;
        const snapshot = buildSnapshot(eligibility, studentFacts(student), overriding ? { status: "override" } : {});
        const overrideRecord = overriding ? { by: user._id, byName: user.name || "", at: now, note: cleanNote } : null;
        const entry = timelineEntry("applied", user, cleanNote || "Added by the placement office");
        let application;
        if (existing) {
            application = await Application.findOneAndUpdate(
                { _id: existing._id, status: "withdrawn" },
                {
                    $set: {
                        status: "applied", appliedAt: now, withdrawnAt: null, decidedAt: null, eligibilitySnapshot: snapshot,
                        eligibilityOverride: overrideRecord, resume, source: "tpo", academicYear: academicYearFor(now),
                    },
                    $push: { timeline: entry },
                },
                { returnDocument: "after" },
            ).lean();
            if (!application) throw fail(409, "The student already has an application for this drive", "ALREADY_APPLIED");
        } else {
            try {
                application = (await Application.create({
                    job: job._id,
                    student: student._id,
                    college: job.college ?? student.college ?? null,
                    company: job.company?._id ?? job.company,
                    academicYear: academicYearFor(now),
                    status: "applied",
                    timeline: [entry],
                    resume,
                    eligibilitySnapshot: snapshot,
                    eligibilityOverride: overrideRecord,
                    source: "tpo",
                    appliedAt: now,
                })).toObject();
            } catch (error) {
                if (error?.code === 11000) throw fail(409, "The student already has an application for this drive", "ALREADY_APPLIED");
                throw error;
            }
        }
        await lockAppliedResume(resume?.id);
        await events.applicationStatusToStudent(application, job, {
            title: `Added to ${job.company?.name || "a drive"} – ${job.title}`,
            note: cleanNote || "The placement office added you to this drive.",
        });
        await emitApplicationChange(application, "created");
        return { application: await loadStaffView(application._id, user) };
    });
};

// ── Staff listing and export ────────────────────────────────────────────────

const STATUS_ORDER = (status) => PIPELINE_ORDER[status] ?? 99;

/**
 * Shared filtering for GET /applications, GET /jobs/:id/applications and the CSV export.
 * @returns {Promise<{base: object, filter: object, job: object|null}>}
 */
const buildApplicationFilter = async (user, query = {}, { jobId } = {}) => {
    staffOnly(user);
    const scope = applicationScope(user, { collegeId: user.role === "admin" ? query.collegeId : undefined });
    const parts = [scope];
    let job = null;
    const requestedJob = jobId ?? (query.jobId === "" ? undefined : query.jobId);
    if (requestedJob !== undefined && requestedJob !== null) {
        assertObjectId(String(requestedJob), "jobId");
        job = await Job.findOne(andFilters({ _id: toObjectId(requestedJob) }, await resolveJobScope(user)))
            .populate("company", "name").populate("createdBy", "name role").lean();
        if (!job) throw notFound("Drive");
        parts.push({ job: job._id });
    }
    if (query.eligible === "true" || query.eligible === true) parts.push({ "eligibilitySnapshot.eligible": true });
    else if (query.eligible === "false" || query.eligible === false) parts.push({ "eligibilitySnapshot.eligible": { $ne: true } });

    const branch = str(query.branch, { field: "branch", max: 100 });
    const passingYear = str(query.passingYear, { field: "passingYear", max: 10 });
    const q = str(query.q, { field: "q", max: 200 });
    if (branch || passingYear || q) {
        const studentIds = await Application.distinct("student", andFilters(...parts));
        const userFilter = { _id: { $in: studentIds } };
        if (passingYear) userFilter.passingYear = passingYear;
        if (q) {
            const pattern = new RegExp(escapeRegex(q), "i");
            userFilter.$or = [{ name: pattern }, { email: pattern }, { rollNumber: pattern }, { ggsipuEnrollment: pattern }];
        }
        let students = await User.find(userFilter).select("branch").lean();
        if (branch) students = students.filter((student) => branchMatches(student.branch, [branch]));
        parts.push({ student: { $in: students.map((student) => student._id) } });
    }
    const base = andFilters(...parts);
    const statuses = enumList(query.status, APPLICATION_STATUSES, { field: "status" });
    const filter = statuses ? andFilters(base, { status: { $in: statuses } }) : base;
    return { base, filter, job };
};

const statusCountsFor = async (filter) => {
    const rows = await Application.aggregate([{ $match: filter }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    const counts = emptyApplicationCounts();
    for (const row of rows) counts[row._id] = row.n;
    return counts;
};

const sortApplications = (rows, sort) => {
    const byName = (a, b) => String(a.student?.name || "").localeCompare(String(b.student?.name || ""), "en", { sensitivity: "base" });
    const byCgpa = (a, b) => (b.student?.cgpa ?? -1) - (a.student?.cgpa ?? -1);
    const byRecent = (a, b) => new Date(b.appliedAt) - new Date(a.appliedAt);
    if (sort === "cgpa") return rows.sort((a, b) => byCgpa(a, b) || byName(a, b));
    if (sort === "name") return rows.sort((a, b) => byName(a, b) || byRecent(a, b));
    if (sort === "status") return rows.sort((a, b) => STATUS_ORDER(a.status) - STATUS_ORDER(b.status) || byCgpa(a, b) || byName(a, b));
    return rows.sort(byRecent);
};

const SORTS = ["recent", "cgpa", "name", "status"];

/**
 * GET /applications and GET /jobs/:id/applications.
 * @returns {Promise<{items, total, page, limit, statusCounts, job?}>}
 */
export const listApplications = async (user, query = {}, { jobId } = {}) => {
    const { base, filter, job } = await buildApplicationFilter(user, query, { jobId });
    const page = intParam(query.page, { min: 1, max: 100000, fallback: 1 });
    const limit = intParam(query.limit, { min: 1, max: 200, fallback: 50 });
    const sort = oneOf(query.sort, SORTS, { field: "sort" }) || "recent";
    const [total, statusCounts] = await Promise.all([Application.countDocuments(filter), statusCountsFor(base)]);
    let rows;
    if (sort === "recent") {
        rows = await Application.find(filter).populate(STAFF_POPULATE).sort({ appliedAt: -1, _id: -1 })
            .skip((page - 1) * limit).limit(limit).lean();
    } else {
        const all = await Application.find(filter).populate(STAFF_POPULATE).limit(MAX_CSV_ROWS).lean();
        rows = sortApplications(all, sort).slice((page - 1) * limit, page * limit);
    }
    const result = { items: rows.map((row) => toApplicationStaffView(row, { viewer: user })), total, page, limit, statusCounts };
    if (job) result.job = (await buildStaffJobViews([job]))[0];
    return result;
};

/** Applicants for one drive (tool applicants_list): pipeline order then CGPA desc, at most 50. */
export const listApplicantsForAgent = async (user, jobId, { status } = {}) => {
    const { base, filter } = await buildApplicationFilter(user, { status }, { jobId });
    const [total, statusCounts, rows] = await Promise.all([
        Application.countDocuments(filter),
        statusCountsFor(base),
        Application.find(filter).populate(STAFF_POPULATE).limit(MAX_CSV_ROWS).lean(),
    ]);
    const sorted = sortApplications(rows, "status").slice(0, 50);
    return { applications: sorted.map((row) => toApplicationStaffView(row, { viewer: user })), total, statusCounts };
};

const ELIGIBLE_AT_APPLY = Object.freeze({ eligible: "Yes", ineligible: "No", incomplete: "Incomplete", override: "Override" });
const isPolicyReason = (reason) => /^One-offer policy:/i.test(String(reason || ""));

export const CSV_HEADERS = Object.freeze([
    "Application ID", "Student Name", "Email", "Roll Number", "Enrollment", "Branch", "Section", "Passing Year", "CGPA",
    "Active Backlogs", "Eligible At Apply", "Eligibility Notes", "Status", "Applied At", "Last Updated", "Company", "Role",
    "Resume", "Offer Status", "Offer Package (LPA)",
]);

/** GET /applications/export.csv and GET /jobs/:id/applications/export.csv → {filename, csv}. */
export const exportApplicationsCsv = async (user, query = {}, { jobId } = {}) => {
    const { filter, job } = await buildApplicationFilter(user, query, { jobId });
    const rows = await Application.find(filter).populate(STAFF_POPULATE).sort({ appliedAt: -1 }).limit(MAX_CSV_ROWS).lean();
    const hidePolicy = user.role === "company";
    const values = [
        (row) => idOf(row._id),
        (row) => row.student?.name ?? "",
        (row) => row.student?.email ?? "",
        (row) => row.student?.rollNumber ?? "",
        (row) => row.student?.ggsipuEnrollment ?? "",
        (row) => row.student?.branch ?? "",
        (row) => row.student?.section ?? "",
        (row) => row.student?.passingYear ?? "",
        (row) => row.student?.cgpa ?? "",
        (row) => row.student?.activeBacklogs ?? "",
        (row) => ELIGIBLE_AT_APPLY[row.eligibilitySnapshot?.status] || "Unknown",
        (row) => (row.eligibilitySnapshot?.reasons || []).filter((reason) => !hidePolicy || !isPolicyReason(reason)).join("; "),
        (row) => statusLabel(row.status),
        (row) => formatDateTime(row.appliedAt),
        (row) => formatDateTime(row.updatedAt),
        (row) => row.job?.company?.name ?? "",
        (row) => row.job?.title ?? "",
        (row) => (row.resume?.title ? row.resume.title : ""),
        (row) => row.offer?.status ?? "",
        (row) => (row.offer?.packageLpa !== undefined && row.offer?.packageLpa !== null ? formatLpa(row.offer.packageLpa) : ""),
    ];
    const columns = CSV_HEADERS.map((header, index) => ({ header, value: values[index] }));
    const date = new Date(clock.now()).toISOString().slice(0, 10);
    const filename = job
        ? `applicants-${slug(job.company?.name, "company")}-${slug(job.title, "drive")}-${date}.csv`
        : `applicants-${date}.csv`;
    return { filename, csv: toCsv(columns, rows) };
};

/** GET /applications/:id/resume → {url, expiresAt}. */
export const applicationResumeUrl = async (user, applicationId) => {
    const application = await loadApplicationInScope(user, applicationId, { populate: [] });
    if (!application.resume?.id) throw fail(404, "No resume is attached to this application", "RESUME_NOT_FOUND");
    const resume = await Resume.findOne({ _id: application.resume.id, owner: application.student }).lean();
    if (!resume) throw fail(404, "The attached resume no longer exists", "RESUME_NOT_FOUND");
    const bank = await resumeBank();
    if (typeof bank.buildPrivateResumeUrl !== "function") throw fail(503, "Resume storage is not available", "RESUME_STORAGE_UNAVAILABLE");
    const url = await bank.buildPrivateResumeUrl(resume, { viewerId: user._id });
    const ttlSeconds = Number(process.env.RESUME_FILE_URL_TTL_SECONDS) > 0 ? Number(process.env.RESUME_FILE_URL_TTL_SECONDS) : 600;
    return { url, expiresAt: new Date(clock.now().getTime() + ttlSeconds * 1000).toISOString() };
};

// ── Offer → application sync (§7.4) ─────────────────────────────────────────

const SYNC_TARGETS = Object.freeze({
    extended: "offered",
    accepted: "hired",
    placed: "hired",
    rejected: "withdrawn",
    expired: "withdrawn",
});

/**
 * Mirror an offer's status onto its application.
 * @param {object} offer
 * @param {{byStudent?: boolean, notify?: boolean, revoked?: boolean, note?: string, actor?: object}} [options]
 */
export const syncFromOffer = async (offer, { byStudent = false, notify = true, revoked = false, note, actor = null } = {}) => {
    if (!offer?.application) return null;
    let target = SYNC_TARGETS[offer.status];
    let defaultNote;
    switch (offer.status) {
    case "extended": defaultNote = `Offer extended: ${formatLpa(offer.packageLpa)} LPA`; break;
    case "accepted": defaultNote = "Offer accepted"; break;
    case "placed": defaultNote = "Placement confirmed"; break;
    case "rejected": defaultNote = "Offer declined"; break;
    case "expired": defaultNote = "Offer expired"; break;
    case "withdrawn":
        target = revoked ? "rejected" : "withdrawn";
        defaultNote = revoked ? "Offer revoked" : "Offer acceptance withdrawn";
        break;
    default: return null;
    }
    const application = await Application.findById(offer.application).populate({ path: "job", select: JOB_FIELDS, populate: { path: "company", select: "name" } }).lean();
    if (!application) return null;
    const now = clock.now();
    const set = { offer: offer._id };
    const update = { $set: set };
    if (application.status !== target) {
        set.status = target;
        if (target === "hired" || target === "rejected") set.decidedAt = now;
        if (target === "withdrawn") set.withdrawnAt = now;
        update.$push = { timeline: timelineEntry(target, actor, note || defaultNote) };
    }
    const updated = await Application.findOneAndUpdate({ _id: application._id }, update, { returnDocument: "after" }).lean();
    if (!updated) return null;
    if (application.status !== target) {
        if (notify && !byStudent) await events.applicationStatusToStudent(updated, application.job || { title: "your drive" }, { note: note || defaultNote });
        await emitApplicationChange(updated, target === "withdrawn" ? "withdrawn" : "updated");
    }
    return updated;
};

