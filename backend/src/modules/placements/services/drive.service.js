// Campus drives: CRUD, review/publish/close, listing per role, the AI job creator upsert and the
// agent metadata (docs/contracts/PLACEMENTS.md §6.1, §7.1, §8).
import crypto from "node:crypto";
import mongoose from "mongoose";
import { assertObjectId, escapeRegex, fail, intParam, isObjectId } from "../../../core/http.js";
import { Company } from "../../../models/company.models.js";
import { Job } from "../../../models/job.models.js";
import { User } from "../../../models/user.models.js";
import { placementsConfig } from "../config.js";
import { DRIVE_STATUSES, ROUND_MODES, isStaff } from "../constants.js";
import { Application } from "../models/application.model.js";
import { clock, dayKey, endOfDay, addDays, parseDateInput } from "../utils/dates.js";
import { enumList, httpsUrl, list, num, oneOf, str } from "../utils/input.js";
import { evaluateForJob, evaluateForJobs } from "./eligibility.service.js";
import * as events from "./events.js";
import { packageLabel, parsePackageLpa } from "./package.js";
import { andFilters, collegeScope, companyScope, notFound, resolveJobScope } from "./scope.js";
import { skillMatch, studentSkills } from "./skills.js";
import {
    idOf,
    isDriveOpen,
    toAgentJobSummary,
    toJobView,
    toStaffJobView,
    toStudentJobView,
} from "./views.js";

export const COMPANY_POPULATE = { path: "company", select: "name" };
export const CREATOR_POPULATE = { path: "createdBy", select: "name role" };
const STUDENT_CANDIDATE_LIMIT = 500;

const invalid = (field, message) => fail(400, message, "VALIDATION", { field });
const has = (body, key) => Object.hasOwn(body, key) && body[key] !== undefined;
const firstKey = (body, keys) => keys.find((key) => has(body, key));
const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "")
    || (typeof value === "number" && Number.isNaN(value));

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

// ── Companies ───────────────────────────────────────────────────────────────

/** Find a Company by case-insensitive exact name, or create it. */
export const findOrCreateCompany = async (name) => {
    const clean = String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
    if (!clean) throw invalid("companyName", "companyName is required");
    const existing = await Company.findOne({ name: { $regex: `^${escapeRegex(clean)}$`, $options: "i" } });
    if (existing) return existing;
    return Company.create({ name: clean });
};

// ── Input normalisation (§6.1) ──────────────────────────────────────────────

const normalizeRounds = (value) => {
    if (isBlank(value)) return [];
    if (!Array.isArray(value)) throw invalid("rounds", "rounds must be a list");
    if (value.length > 10) throw invalid("rounds", "At most 10 rounds");
    return value.map((round, index) => {
        if (!round || typeof round !== "object") throw invalid("rounds", `rounds[${index}] must be an object`);
        const field = `rounds[${index}]`;
        return {
            name: str(round.name, { field: `${field}.name`, max: 120, required: true }),
            at: isBlank(round.at) ? null : parseDateInput(round.at, { field: `${field}.at` }),
            venue: str(round.venue, { field: `${field}.venue`, max: 200 }) ?? "",
            mode: oneOf(round.mode, ROUND_MODES, { field: `${field}.mode` }) ?? "offline",
            notes: str(round.notes, { field: `${field}.notes`, max: 500 }) ?? "",
        };
    });
};

const normalizeGraduationYears = (value) => {
    const items = list(Array.isArray(value) ? value.map((item) => (item === null || item === undefined ? item : String(item))) : value,
        { maxItems: 10, maxLen: 10, field: "graduationYears" });
    return items.map((item) => {
        if (!/^\d{4}$/.test(item) || Number(item) < 2000 || Number(item) > 2100) {
            throw invalid("graduationYears", "graduationYears must be four-digit years between 2000 and 2100");
        }
        return item;
    });
};

const normalizePackage = (body) => {
    const sources = ["packageLpa", "salary", "ctc"].filter((key) => has(body, key));
    if (sources.length === 0) return null;
    let parsed = { min: null, max: null };
    for (const key of sources) {
        const candidate = body[key];
        if (isBlank(candidate)) continue;
        parsed = parsePackageLpa(typeof candidate === "number" ? candidate : String(candidate));
        if (parsed.min !== null) break;
    }
    const textKey = ["salary", "packageLpa", "ctc"].find((key) => has(body, key) && typeof body[key] === "string" && body[key].trim());
    let salary;
    if (textKey) salary = str(body[textKey], { field: textKey, max: 100 });
    else if (parsed.min !== null) salary = packageLabel({ packageLpa: parsed.min, packageMaxLpa: parsed.max });
    else salary = "not disclosed";
    return { salary, packageLpa: parsed.min, packageMaxLpa: parsed.max };
};

/**
 * Map the CompanyMode.jsx / API / tool field set onto canonical Job fields.
 * @returns {{set: object, unset: string[], companyName?: string, collegeId?: string, status?: string}}
 */
export const normalizeDriveInput = (body = {}, user, { partial = false, existing = null } = {}) => {
    const input = body && typeof body === "object" ? body : {};
    const set = {};
    const unset = [];
    const out = { set, unset };

    if (user.role !== "company") {
        const companyKey = firstKey(input, ["companyName", "company"]);
        const companyValue = companyKey ? input[companyKey] : undefined;
        if (companyKey && typeof companyValue === "string") {
            out.companyName = str(companyValue, { field: "companyName", max: 200, required: !partial });
        } else if (!partial) {
            throw invalid("companyName", "companyName is required");
        }
    }

    const titleKey = firstKey(input, ["title", "roleTitle", "job_role"]);
    if (titleKey || !partial) {
        set.title = str(titleKey ? input[titleKey] : undefined, { field: "title", min: 2, max: 300, required: true });
    }
    const descriptionKey = firstKey(input, ["description", "jdText"]);
    if (descriptionKey || !partial) {
        set.description = str(descriptionKey ? input[descriptionKey] : undefined, { field: "description", max: 20000, required: true });
    }

    const pkg = normalizePackage(input);
    if (pkg) Object.assign(set, pkg);

    const numericFields = [
        ["minimumCgpa", ["minimumCgpa", "minCgpa", "minimum_cgpa"], { min: 0, max: 10 }],
        ["maximumBacklogs", ["maximumBacklogs", "maxBacklogs", "maximum_backlogs"], { min: 0, max: 50, int: true }],
        ["min10thPercentage", ["min10thPercentage"], { min: 0, max: 100 }],
        ["min12thPercentage", ["min12thPercentage"], { min: 0, max: 100 }],
    ];
    for (const [field, keys, rules] of numericFields) {
        const key = firstKey(input, keys);
        if (!key) continue;
        const value = num(input[key], { ...rules, field });
        if (value === undefined) unset.push(field);
        else set[field] = value;
    }

    const branchesKey = firstKey(input, ["eligibleBranches", "eligibleBranch", "branches"]);
    if (branchesKey) set.eligibleBranches = list(input[branchesKey], { maxItems: 30, maxLen: 100, field: "eligibleBranches" });
    const skillsKey = firstKey(input, ["skills", "skillsRequired"]);
    if (skillsKey) set.skills = list(input[skillsKey], { maxItems: 50, maxLen: 60, field: "skills" });
    const yearsKey = firstKey(input, ["graduationYears", "graduation_years"]);
    if (yearsKey) set.graduationYears = normalizeGraduationYears(input[yearsKey]);

    if (has(input, "location")) set.location = str(input.location, { field: "location", max: 200 }) ?? "";
    if (has(input, "employmentType")) set.employmentType = str(input.employmentType, { field: "employmentType", max: 60 }) ?? "";
    if (has(input, "selectionProcess")) set.selectionProcess = str(input.selectionProcess, { field: "selectionProcess", max: 5000 }) ?? "";
    if (has(input, "rounds")) set.rounds = normalizeRounds(input.rounds);
    if (has(input, "companyLogo")) {
        const logo = httpsUrl(input.companyLogo, { field: "companyLogo" });
        if (logo === undefined) unset.push("companyLogo");
        else set.companyLogo = logo;
    }

    // Dates: deadline = end of day; drive date = start of day.
    const deadlineKey = firstKey(input, ["applicationDeadline", "deadline", "app_deadline"]);
    const deadlineGiven = deadlineKey && !isBlank(input[deadlineKey]);
    const driveGiven = has(input, "driveDate") && !isBlank(input.driveDate);
    if (deadlineGiven) set.applicationDeadline = parseDateInput(input[deadlineKey], { endOfDay: true, field: "applicationDeadline" });
    if (driveGiven) set.driveDate = parseDateInput(input.driveDate, { field: "driveDate" });
    else if (has(input, "driveDate") && partial) set.driveDate = null;
    if (!set.applicationDeadline && set.driveDate && (!partial || !existing?.applicationDeadline)) {
        set.applicationDeadline = endOfDay(addDays(set.driveDate, -1));
    }
    if (!partial && !set.applicationDeadline) throw invalid("applicationDeadline", "applicationDeadline (or driveDate) is required");

    const deadline = set.applicationDeadline ?? existing?.applicationDeadline ?? null;
    const driveDate = set.driveDate !== undefined ? set.driveDate : existing?.driveDate ?? null;
    if (set.applicationDeadline && set.applicationDeadline.getTime() <= clock.now().getTime()) {
        throw fail(400, "The application deadline must be in the future", "DEADLINE_IN_PAST", { field: "applicationDeadline" });
    }
    if (deadline && driveDate && dayKey(driveDate) < dayKey(deadline)) {
        throw invalid("driveDate", "driveDate must be on or after the application deadline");
    }

    if (!partial && isStaff(user) && has(input, "status")) {
        out.status = oneOf(input.status, ["draft", "active"], { field: "status" }) ?? "active";
    }
    if (user.role === "admin" && has(input, "collegeId") && !isBlank(input.collegeId)) {
        if (!isObjectId(String(input.collegeId))) throw invalid("collegeId", "collegeId must be a valid id");
        out.collegeId = String(input.collegeId);
    }
    return out;
};

// ── Loading and counting ────────────────────────────────────────────────────

/** A drive in the caller's scope (404 otherwise). */
export const loadJobInScope = async (user, jobId, { lean = false } = {}) => {
    assertObjectId(String(jobId ?? ""), "jobId");
    const scope = await resolveJobScope(user);
    const query = Job.findOne(andFilters({ _id: toObjectId(jobId) }, scope)).populate(COMPANY_POPULATE).populate(CREATOR_POPULATE);
    const job = lean ? await query.lean() : await query;
    if (!job) throw notFound("Drive");
    return job;
};

/** `Map<jobId, {status: count}>` from one aggregate. */
export const applicationCountsByJob = async (jobIds) => {
    const ids = jobIds.map((id) => toObjectId(idOf(id)));
    const counts = new Map(ids.map((id) => [String(id), {}]));
    if (ids.length === 0) return counts;
    const rows = await Application.aggregate([
        { $match: { job: { $in: ids } } },
        { $group: { _id: { job: "$job", status: "$status" }, n: { $sum: 1 } } },
    ]);
    for (const row of rows) {
        const key = String(row._id.job);
        counts.set(key, { ...(counts.get(key) || {}), [row._id.status]: row.n });
    }
    return counts;
};

const studentApplicationsByJob = async (studentId, jobIds) => {
    if (!studentId || jobIds.length === 0) return new Map();
    const rows = await Application.find({ student: studentId, job: { $in: jobIds.map((id) => toObjectId(idOf(id))) } })
        .select("job status appliedAt updatedAt")
        .lean();
    return new Map(rows.map((row) => [String(row.job), row]));
};

/** Student views for a list of jobs (eligibility, match, own application). */
export const buildStudentJobViews = async (user, jobs, { now = clock.now() } = {}) => {
    const [eligibility, applications] = await Promise.all([
        evaluateForJobs(user, jobs),
        studentApplicationsByJob(user._id, jobs.map((job) => job._id)),
    ]);
    const skills = studentSkills(user);
    return jobs.map((job) => toStudentJobView(job, {
        eligibility: eligibility.get(String(job._id)),
        match: skillMatch(skills, job.skills),
        application: applications.get(String(job._id)) || null,
        now,
    }));
};

export const buildStaffJobViews = async (jobs, { now = clock.now() } = {}) => {
    const counts = await applicationCountsByJob(jobs.map((job) => job._id));
    return jobs.map((job) => toStaffJobView(job, { counts: counts.get(String(job._id)), now }));
};

/** The role-specific view of one drive. */
export const viewJobFor = async (user, job) => {
    if (user.role === "student") return (await buildStudentJobViews(user, [job]))[0];
    if (isStaff(user) || user.role === "company") return (await buildStaffJobViews([job]))[0];
    return toJobView(job);
};

const textFilter = async (q) => {
    const text = str(q, { field: "q", max: 200 });
    if (!text) return null;
    const pattern = new RegExp(escapeRegex(text), "i");
    const companies = await Company.find({ name: pattern }).select("_id").limit(50).lean();
    return {
        $or: [
            { title: pattern },
            { skills: pattern },
            { location: pattern },
            ...(companies.length ? [{ company: { $in: companies.map((company) => company._id) } }] : []),
        ],
    };
};

const commonFilters = async (query = {}) => {
    const filters = [];
    const text = await textFilter(query.q ?? query.query);
    if (text) filters.push(text);
    const location = str(query.location, { field: "location", max: 200 });
    if (location) filters.push({ location: new RegExp(escapeRegex(location), "i") });
    const minPackage = num(query.minPackageLpa, { field: "minPackageLpa", min: 0, max: 500 });
    if (minPackage !== undefined) filters.push({ packageLpa: { $ne: null, $gte: minPackage } });
    return filters;
};

const deadlineValue = (view) => (view.applicationDeadline ? new Date(view.applicationDeadline).getTime() : Number.POSITIVE_INFINITY);
const createdValue = (view) => (view.createdAt ? new Date(view.createdAt).getTime() : 0);

/** Open drives first by deadline asc (nulls last), then the rest by createdAt desc. */
export const compareByDeadline = (a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    if (a.isOpen) return deadlineValue(a) - deadlineValue(b) || createdValue(b) - createdValue(a);
    return createdValue(b) - createdValue(a);
};

const compareViews = (sort) => {
    if (sort === "recent") return (a, b) => createdValue(b) - createdValue(a);
    if (sort === "package") return (a, b) => (b.packageLpa ?? -1) - (a.packageLpa ?? -1) || compareByDeadline(a, b);
    if (sort === "match") return (a, b) => (b.matchPercentage ?? -1) - (a.matchPercentage ?? -1) || compareByDeadline(a, b);
    return compareByDeadline;
};

const SORTS = ["deadline", "recent", "match", "package"];

/** GET /jobs (§6.1) → an array of role views. */
export const listDrives = async (user, query = {}) => {
    const limit = intParam(query.limit, { min: 1, max: 200, fallback: 100 });
    const page = intParam(query.page, { min: 1, max: 100000, fallback: 1 });
    const sort = oneOf(query.sort, SORTS, { field: "sort" });
    const now = clock.now();
    const scope = await resolveJobScope(user, { collegeId: user.role === "admin" ? query.collegeId : undefined });
    const filters = await commonFilters(query);

    if (user.role === "student") {
        const jobs = await Job.find(andFilters(scope, ...filters))
            .populate(COMPANY_POPULATE)
            .sort({ createdAt: -1 })
            .limit(STUDENT_CANDIDATE_LIMIT)
            .lean();
        let views = await buildStudentJobViews(user, jobs, { now });
        if (query.eligibleOnly === true || query.eligibleOnly === "true") views = views.filter((view) => view.isEligible);
        views.sort(compareViews(sort || "deadline"));
        return views.slice((page - 1) * limit, page * limit);
    }

    if (isStaff(user) || user.role === "company") {
        const statuses = enumList(query.status, DRIVE_STATUSES, { field: "status" });
        if (statuses) filters.push({ status: { $in: statuses } });
        const filter = andFilters(scope, ...filters);
        const effectiveSort = sort || "recent";
        if (effectiveSort === "recent" || effectiveSort === "match") {
            const jobs = await Job.find(filter).populate(COMPANY_POPULATE).populate(CREATOR_POPULATE)
                .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
            return buildStaffJobViews(jobs, { now });
        }
        const jobs = await Job.find(filter).populate(COMPANY_POPULATE).populate(CREATOR_POPULATE)
            .sort({ createdAt: -1 }).limit(2000).lean();
        const views = await buildStaffJobViews(jobs, { now });
        views.sort(compareViews(effectiveSort));
        return views.slice((page - 1) * limit, page * limit);
    }

    const jobs = await Job.find(andFilters(scope, ...filters)).populate(COMPANY_POPULATE)
        .sort({ createdAt: -1 }).limit(STUDENT_CANDIDATE_LIMIT).lean();
    const views = jobs.map((job) => toJobView(job, { now }));
    views.sort(compareViews(sort || "recent"));
    return views.slice((page - 1) * limit, page * limit);
};

/** GET /drives/matched: eligible, open drives by match % desc then deadline asc. */
export const listMatchedDrives = async (user, query = {}) => {
    const limit = intParam(query.limit, { min: 1, max: 100, fallback: 20 });
    const scope = await resolveJobScope(user);
    const jobs = await Job.find(andFilters(scope, { status: "active" }))
        .populate(COMPANY_POPULATE)
        .sort({ createdAt: -1 })
        .limit(STUDENT_CANDIDATE_LIMIT)
        .lean();
    const views = (await buildStudentJobViews(user, jobs)).filter((view) => view.isEligible && view.isOpen);
    views.sort((a, b) => (b.matchPercentage ?? -1) - (a.matchPercentage ?? -1) || deadlineValue(a) - deadlineValue(b));
    return views.slice(0, limit);
};

/** GET /jobs/:id */
export const getDrive = async (user, jobId) => viewJobFor(user, await loadJobInScope(user, jobId, { lean: true }));

// ── Lifecycle ───────────────────────────────────────────────────────────────

const actorName = (user) => user?.name || "Placement office";

const staffView = async (jobId) => {
    const job = await Job.findById(jobId).populate(COMPANY_POPULATE).populate(CREATOR_POPULATE).lean();
    return (await buildStaffJobViews([job]))[0];
};

/**
 * Publish (§7.1): status active, publishedAt, approval review; announce once.
 * @returns {Promise<{job: object, notifiedStudents: number}>}
 */
const publishLoaded = async (user, job, { note = "", auto = false } = {}) => {
    const from = job.status || "active";
    if (from === "active") throw fail(409, "This drive is already published", "INVALID_TRANSITION");
    if (job.applicationDeadline && new Date(job.applicationDeadline).getTime() <= clock.now().getTime()) {
        throw fail(409, "The application deadline has passed; move it to a future date before publishing", "DEADLINE_PASSED");
    }
    const now = clock.now();
    const set = { status: "active", closedAt: null, closedReason: null };
    if (!job.publishedAt) set.publishedAt = now;
    const reviewed = from === "pending" || from === "rejected";
    if (reviewed) {
        set.review = {
            decision: "approved",
            by: auto ? null : user._id,
            byName: auto ? "Auto-approved" : actorName(user),
            at: now,
            note: note || "",
        };
    }
    const updated = await Job.findOneAndUpdate(
        { _id: job._id, status: job.status ?? { $in: [null] } },
        { $set: set },
        { returnDocument: "after", runValidators: true },
    ).populate(COMPANY_POPULATE).lean();
    if (!updated) throw fail(409, "The drive changed while it was being published; reload and try again", "INVALID_TRANSITION");
    const notifiedStudents = await events.drivePublished(updated);
    if (reviewed && !auto) events.driveStatusToRecruiters(updated, "approved", note);
    events.jobChanged(updated, "published");
    return { job: updated, notifiedStudents };
};

/** POST /jobs (tpo/admin/company). */
export const createDrive = async (user, body = {}) => {
    const isCompany = user.role === "company";
    if (isCompany) companyScope(user);
    const input = normalizeDriveInput(body, user, { partial: false });
    const company = isCompany ? await Company.findById(user.company) : await findOrCreateCompany(input.companyName);
    if (!company) throw fail(403, "Your recruiter account is linked to a company that no longer exists", "COMPANY_NOT_LINKED");

    let college = user.college ?? null;
    if (user.role === "admin") college = input.collegeId ? toObjectId(input.collegeId) : (user.college ?? null);

    const status = isCompany ? "pending" : (input.status || "active");
    const created = await Job.create({
        ...input.set,
        company: company._id,
        college,
        createdBy: user._id,
        createdByRole: isCompany ? "company" : user.role === "admin" ? "admin" : "tpo",
        status: status === "active" ? "draft" : status,
        notifiedAt: null,
    });

    let notifiedStudents = null;
    if (isCompany && placementsConfig.companyAutoApprove) {
        ({ notifiedStudents } = await publishLoaded(user, created.toObject(), { auto: true }));
    } else if (isCompany) {
        events.driveSubmitted(created, { recruiterName: user.name });
        events.jobChanged(created, "created");
    } else if (status === "active") {
        ({ notifiedStudents } = await publishLoaded(user, created.toObject()));
    } else {
        events.jobChanged(created, "created");
    }
    return { job: await staffView(created._id), notifiedStudents };
};

const COMPANY_EDITABLE = ["draft", "pending", "rejected"];

/** PATCH /jobs/:id (tpo; company own while draft/pending/rejected). No `status`. */
export const updateDrive = async (user, jobId, body = {}) => {
    const job = await loadJobInScope(user, jobId, { lean: true });
    const isCompany = user.role === "company";
    if (isCompany && !COMPANY_EDITABLE.includes(job.status)) {
        throw fail(403, "Published or closed drives can only be changed by the placement office", "FORBIDDEN");
    }
    const { status: _ignored, collegeId: _college, ...rest } = body || {};
    const input = normalizeDriveInput(rest, user, { partial: true, existing: job });
    const update = { $set: { ...input.set } };
    if (input.unset.length) update.$unset = Object.fromEntries(input.unset.map((field) => [field, ""]));
    if (input.companyName) {
        const company = await findOrCreateCompany(input.companyName);
        update.$set.company = company._id;
    }
    const resubmitted = isCompany && job.status === "rejected";
    if (resubmitted) update.$set.status = "pending";
    if (Object.keys(update.$set).length === 0 && !update.$unset) return { job: await staffView(job._id) };

    const updated = await Job.findOneAndUpdate({ _id: job._id }, update, { returnDocument: "after", runValidators: true })
        .populate(COMPANY_POPULATE).lean();
    if (!updated) throw notFound("Drive");
    if (resubmitted) events.driveSubmitted(updated, { recruiterName: user.name });
    events.jobChanged(updated, "updated");
    return { job: await staffView(updated._id) };
};

/** DELETE /jobs/:id — only without applications. */
export const deleteDrive = async (user, jobId) => {
    const job = await loadJobInScope(user, jobId, { lean: true });
    if (user.role === "company" && !COMPANY_EDITABLE.includes(job.status)) {
        throw fail(403, "Published or closed drives can only be removed by the placement office", "FORBIDDEN");
    }
    const applications = await Application.countDocuments({ job: job._id });
    if (applications > 0) throw fail(409, `This drive has ${applications} application(s); close it instead`, "HAS_APPLICATIONS");
    await Job.deleteOne({ _id: job._id });
    events.jobChanged({ ...job, status: job.status }, "deleted");
    return { deleted: true };
};

/** POST /jobs/:id/publish (tpo). */
export const publishDrive = async (user, jobId, { note } = {}) => {
    const cleanNote = str(note, { field: "note", max: 500 }) ?? "";
    const job = await loadJobInScope(user, jobId, { lean: true });
    const result = await publishLoaded(user, job, { note: cleanNote });
    return { job: await staffView(result.job._id), notifiedStudents: result.notifiedStudents };
};

/** POST /jobs/:id/reject (tpo): pending → rejected with a note the recruiter sees. */
export const rejectDrive = async (user, jobId, { note } = {}) => {
    const cleanNote = str(note, { field: "note", min: 3, max: 500, required: true });
    const job = await loadJobInScope(user, jobId, { lean: true });
    if (job.status !== "pending") throw fail(409, "Only drives awaiting approval can be rejected", "INVALID_TRANSITION");
    const updated = await Job.findOneAndUpdate(
        { _id: job._id, status: "pending" },
        { $set: { status: "rejected", review: { decision: "rejected", by: user._id, byName: actorName(user), at: clock.now(), note: cleanNote } } },
        { returnDocument: "after", runValidators: true },
    ).populate(COMPANY_POPULATE).lean();
    if (!updated) throw fail(409, "Only drives awaiting approval can be rejected", "INVALID_TRANSITION");
    events.driveStatusToRecruiters(updated, "rejected", cleanNote);
    events.jobChanged(updated, "rejected");
    return { job: await staffView(updated._id) };
};

/** POST /jobs/:id/close (tpo; company own). Closed → 200 unchanged. */
export const closeDrive = async (user, jobId, { reason } = {}) => {
    const cleanReason = str(reason, { field: "reason", max: 500 }) ?? "";
    const job = await loadJobInScope(user, jobId, { lean: true });
    if (job.status === "closed") return { job: await staffView(job._id) };
    if (job.status === "rejected") throw fail(409, "A rejected drive cannot be closed", "INVALID_TRANSITION");
    const updated = await Job.findOneAndUpdate(
        { _id: job._id, status: job.status ?? { $in: [null] } },
        { $set: { status: "closed", closedAt: clock.now(), closedReason: "manual" } },
        { returnDocument: "after" },
    ).populate(COMPANY_POPULATE).lean();
    if (!updated) throw fail(409, "The drive changed while it was being closed; reload and try again", "INVALID_TRANSITION");
    if (isStaff(user)) events.driveStatusToRecruiters(updated, "closed", cleanReason);
    events.jobChanged(updated, "closed");
    return { job: await staffView(updated._id) };
};

/** GET /jobs/:id/eligibility — the student themself, or a TPO with ?studentId=. */
export const driveEligibility = async (user, jobId, { studentId } = {}) => {
    const job = await loadJobInScope(user, jobId, { lean: true });
    let student = user;
    if (user.role !== "student") {
        if (!isStaff(user)) throw fail(403, "Only students and the placement office can check eligibility", "FORBIDDEN");
        assertObjectId(String(studentId ?? ""), "studentId");
        student = await User.findOne(andFilters({ _id: toObjectId(studentId), role: "student" }, collegeScope(user))).lean();
        if (!student) throw notFound("Student");
    }
    const eligibility = await evaluateForJob(student, job);
    const match = skillMatch(studentSkills(student), job.skills);
    return { jobId: idOf(job._id), studentId: idOf(student._id), eligibility, ...match };
};

// ── Agent helpers ───────────────────────────────────────────────────────────

/** Agent summaries for drives (with eligibility for students and counts for staff). */
export const buildAgentSummaries = async (user, jobs) => {
    if (user.role === "student") {
        const [eligibility, applications] = await Promise.all([
            evaluateForJobs(user, jobs),
            studentApplicationsByJob(user._id, jobs.map((job) => job._id)),
        ]);
        const skills = studentSkills(user);
        return jobs.map((job) => toAgentJobSummary(job, {
            viewer: user,
            eligibility: eligibility.get(String(job._id)),
            match: skillMatch(skills, job.skills),
            application: applications.get(String(job._id)) || null,
        }));
    }
    if (isStaff(user) || user.role === "company") {
        const counts = await applicationCountsByJob(jobs.map((job) => job._id));
        return jobs.map((job) => toAgentJobSummary(job, { viewer: user, counts: counts.get(String(job._id)) }));
    }
    return jobs.map((job) => toAgentJobSummary(job, { viewer: user }));
};

/** jobs_search_campus: active drives in scope; students eligible-first, then match desc, then deadline. */
export const searchCampusDrives = async (user, { query, location, minPackageLpa, eligibleOnly, limit = 8 } = {}) => {
    const scope = await resolveJobScope(user);
    const filters = await commonFilters({ q: query, location, minPackageLpa });
    const jobs = await Job.find(andFilters(scope, { status: "active" }, ...filters))
        .populate(COMPANY_POPULATE)
        .sort({ createdAt: -1 })
        .limit(STUDENT_CANDIDATE_LIMIT)
        .lean();
    const now = clock.now();
    const open = jobs.filter((job) => isDriveOpen(job, now));
    let summaries = await buildAgentSummaries(user, open);
    if (user.role === "student") {
        if (eligibleOnly) summaries = summaries.filter((summary) => summary.isEligible);
        const deadline = (summary) => (summary.applicationDeadline ? new Date(summary.applicationDeadline).getTime() : Number.POSITIVE_INFINITY);
        summaries.sort((a, b) => (Number(b.isEligible) - Number(a.isEligible))
            || ((b.matchPercentage ?? -1) - (a.matchPercentage ?? -1))
            || (deadline(a) - deadline(b)));
    } else {
        const deadline = (summary) => (summary.applicationDeadline ? new Date(summary.applicationDeadline).getTime() : Number.POSITIVE_INFINITY);
        summaries.sort((a, b) => deadline(a) - deadline(b));
    }
    const total = summaries.length;
    return { jobs: summaries.slice(0, Math.max(1, Math.min(20, limit))), total };
};

/** drives_list: drives in staff/company scope by status. */
export const listDrivesForAgent = async (user, { status = "all" } = {}) => {
    const scope = await resolveJobScope(user);
    const filter = status && status !== "all" ? andFilters(scope, { status }) : scope;
    const [jobs, statusRows] = await Promise.all([
        Job.find(filter).populate(COMPANY_POPULATE).sort({ createdAt: -1 }).limit(200).lean(),
        Job.aggregate([{ $match: scope }, { $group: { _id: { $ifNull: ["$status", "active"] }, n: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries(DRIVE_STATUSES.map((value) => [value, 0]));
    for (const row of statusRows) counts[row._id] = row.n;
    return { jobs, counts, summaries: await buildAgentSummaries(user, jobs.slice(0, 20)) };
};

// ── AI job creator (§8) ─────────────────────────────────────────────────────

const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const normalizeKeyText = (value) => String(value ?? "").toLowerCase().trim().replace(/\s+/g, " ");

export const aiDraftKey = ({ draftId, companyName, role }) => {
    if (typeof draftId === "string" && DRAFT_ID.test(draftId)) return `draft:${draftId}`;
    const digest = crypto.createHash("sha1").update(`${normalizeKeyText(companyName)}|${normalizeKeyText(role)}`).digest("hex");
    return `fp:${digest.slice(0, 24)}`;
};

const optionalNumber = (value, { min, max, int = false } = {}) => {
    if (value === "" || value === null || value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
    return int ? Math.round(parsed) : parsed;
};

const stringList = (value, maxItems, maxLen) => (Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems)
    : []);

const aiRounds = (value) => {
    if (!Array.isArray(value)) return undefined;
    const rounds = [];
    for (const round of value.slice(0, 10)) {
        const name = String((typeof round === "string" ? round : round?.name) ?? "").trim().slice(0, 120);
        if (!name) continue;
        let at = null;
        if (round && typeof round === "object" && round.at) {
            try {
                at = parseDateInput(round.at, { field: "rounds.at" });
            } catch {
                at = null;
            }
        }
        rounds.push({
            name,
            at,
            venue: String(round?.venue ?? "").trim().slice(0, 200),
            mode: round?.mode === "online" ? "online" : "offline",
            notes: String(round?.notes ?? "").trim().slice(0, 500),
        });
    }
    return rounds;
};

/**
 * Persist a job confirmed in the AI job-creator chat (websocket/job-service.js#persistConfirmedJob).
 * One document per draft: {createdBy, sourceSessionId, sourceDraftKey}. Error messages are shown
 * to the user by ai-query-handler.js, so they stay human-readable.
 * @returns {Promise<import("mongoose").Document>}
 */
export const upsertAiCreatedJob = async ({ job, user, sessionId, draftId }) => {
    if (!user || !["tpo", "admin"].includes(user.role)) throw new Error("Only an authenticated TPO can create a job");
    if (!job?.company_name || !job?.job_role || !job?.job_description || !job?.app_deadline) {
        throw new Error("Confirmed job payload is missing required fields");
    }
    let applicationDeadline;
    try {
        applicationDeadline = parseDateInput(job.app_deadline, { endOfDay: true, field: "app_deadline" });
    } catch {
        throw new Error("Confirmed job has an invalid application deadline");
    }
    const now = clock.now();
    if (applicationDeadline.getTime() <= now.getTime()) throw new Error("Confirmed job has an application deadline in the past");

    const companyName = String(job.company_name).trim();
    const title = String(job.job_role).trim();
    let company;
    try {
        company = await findOrCreateCompany(companyName);
    } catch {
        throw new Error("Confirmed job payload is missing required fields");
    }
    const salaryText = typeof job.salary === "string" && job.salary.trim() ? job.salary.trim().slice(0, 100)
        : (typeof job.salary === "number" ? String(job.salary) : "not disclosed");
    const parsedPackage = parsePackageLpa(typeof job.salary === "number" ? job.salary : salaryText);

    const set = {
        title,
        description: String(job.job_description).trim(),
        company: company._id,
        salary: salaryText,
        packageLpa: parsedPackage.min,
        packageMaxLpa: parsedPackage.max,
        eligibleBranches: stringList(job.eligible_branches, 30, 100),
        location: String(job.location ?? "").trim().slice(0, 200),
        employmentType: String(job.employment_type ?? "").trim().slice(0, 60),
        graduationYears: stringList(job.graduation_years, 10, 10).filter((year) => /^\d{4}$/.test(year)),
        skills: stringList(job.skills, 50, 60),
        selectionProcess: String(job.selection_process ?? "").trim().slice(0, 5000),
        applicationDeadline,
        college: user.college ?? null,
        createdByRole: user.role === "admin" ? "admin" : "tpo",
        status: "active",
        closedAt: null,
        closedReason: null,
    };
    const unset = {};
    const optional = [
        ["minimumCgpa", job.minimum_cgpa, { min: 0, max: 10 }],
        ["maximumBacklogs", job.maximum_backlogs, { min: 0, max: 50, int: true }],
        ["min10thPercentage", job.min_tenth_percentage, { min: 0, max: 100 }],
        ["min12thPercentage", job.min_twelfth_percentage, { min: 0, max: 100 }],
    ];
    for (const [field, raw, rules] of optional) {
        const value = optionalNumber(raw, rules);
        if (value !== undefined) set[field] = value;
        else unset[field] = "";
    }
    if (job.drive_date) {
        try {
            const driveDate = parseDateInput(job.drive_date, { field: "drive_date" });
            if (dayKey(driveDate) >= dayKey(applicationDeadline)) set.driveDate = driveDate;
        } catch {
            // An unparseable drive date is dropped; the deadline is what matters for applying.
        }
    }
    const rounds = aiRounds(job.rounds);
    if (rounds) set.rounds = rounds;

    const sourceSessionId = sessionId ? String(sessionId).slice(0, 200) : "no-session";
    const sourceDraftKey = aiDraftKey({ draftId, companyName, role: title });
    // createdBy / sourceSessionId / sourceDraftKey come from the equality filter on insert.
    const update = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;

    const result = await Job.findOneAndUpdate(
        { createdBy: user._id, sourceSessionId, sourceDraftKey },
        update,
        { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true, includeResultMetadata: true },
    );
    const document = result.value;
    await Job.updateOne({ _id: document._id, publishedAt: null }, { $set: { publishedAt: now } });
    events.drivePublished(document, { background: true });
    events.jobChanged(document, result.lastErrorObject?.updatedExisting ? "updated" : "created");
    return document;
};

const AGENT_METADATA_LIMIT = 60;
const AGENT_DESCRIPTION_MAX = 1500;

const isoOrNull = (value) => (value ? new Date(value).toISOString() : null);

/**
 * Active drives for the Python agents' metadata (job-eligibility, interviewer), newest first,
 * capped at 60 with descriptions cut to 1500 characters so the socket packet stays small.
 * @returns {Promise<{jobs: object[], total: number}>}
 */
export const listJobsForAgentMetadata = async (user) => {
    if (!user) return { jobs: [], total: 0 };
    const scope = await resolveJobScope(user);
    const filter = andFilters(scope, { status: "active" });
    const [total, jobs] = await Promise.all([
        Job.countDocuments(filter),
        Job.find(filter)
            .populate(COMPANY_POPULATE)
            .sort({ publishedAt: -1, createdAt: -1 })
            .limit(AGENT_METADATA_LIMIT)
            .lean(),
    ]);
    const isStudentViewer = user.role === "student";
    const [eligibility, applications] = isStudentViewer
        ? await Promise.all([evaluateForJobs(user, jobs), studentApplicationsByJob(user._id, jobs.map((job) => job._id))])
        : [new Map(), new Map()];
    const items = jobs.map((job) => {
        const verdict = eligibility.get(String(job._id));
        return {
            job_id: String(job._id),
            job_title: job.title,
            description: String(job.description || "").slice(0, AGENT_DESCRIPTION_MAX),
            company_id: job.company?._id ? String(job.company._id) : null,
            company_name: job.company?.name || "Unknown Company",
            salary: job.salary || "not disclosed",
            location: job.location || "",
            employment_type: job.employmentType || "",
            min_cgpa: job.minimumCgpa ?? null,
            max_backlogs: job.maximumBacklogs ?? null,
            allowed_branches: job.eligibleBranches || [],
            allowed_graduation_years: (job.graduationYears || []).map(Number).filter(Number.isFinite),
            skills: job.skills || [],
            selection_process: job.selectionProcess || "",
            application_deadline: isoOrNull(job.applicationDeadline),
            status: job.status || "active",
            package_lpa: job.packageLpa ?? null,
            drive_date: isoOrNull(job.driveDate),
            min_tenth_percentage: job.min10thPercentage ?? null,
            min_twelfth_percentage: job.min12thPercentage ?? null,
            server_eligibility: isStudentViewer && verdict
                ? { eligible: verdict.eligible, status: verdict.status, code: verdict.code, reasons: verdict.reasons, missing: verdict.missing }
                : null,
            my_application_status: isStudentViewer ? (applications.get(String(job._id))?.status ?? null) : null,
        };
    });
    return { jobs: items, total };
};
