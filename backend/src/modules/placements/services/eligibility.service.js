// The single source of truth for drive eligibility (docs/contracts/PLACEMENTS.md §4).
//
// Callers: GET /jobs (+ /matched, /:id, /:id/eligibility), apply, staff add, drive.new and
// deadline-reminder recipients, the agent metadata and every agent tool. Facts come ONLY from
// the stored User document (GGSIPU sync or the profile), never from a request body.
import mongoose from "mongoose";
import { User } from "../../../models/user.models.js";
import { HELD_OFFER_STATUSES } from "../constants.js";
import { Application } from "../models/application.model.js";
import { Offer } from "../models/offer.model.js";
import { academicYearFor } from "./academic-year.js";
import { branchMatches, isUnrestricted } from "./branches.js";
import { formatLpa, round2 } from "./package.js";
import { createPolicyCache, resolvePolicy } from "./policy.service.js";

const toNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const toText = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
};

/** Academic facts from the stored User. */
export const studentFacts = (user = {}) => ({
    cgpa: toNumber(user.cgpa),
    activeBacklogs: toNumber(user.activeBacklogs),
    branch: toText(user.branch),
    passingYear: toText(user.passingYear),
    tenthPercentage: toNumber(user.tenthPercentage),
    twelfthPercentage: toNumber(user.twelfthPercentage),
    verified: Boolean(user.ggsipuLinked),
});

const MISSING_LABELS = Object.freeze({
    cgpa: "CGPA",
    activeBacklogs: "active backlogs",
    branch: "branch",
    passingYear: "passing year",
    tenthPercentage: "10th percentage",
    twelfthPercentage: "12th percentage",
});

const joinLabels = (labels) => {
    if (labels.length <= 1) return labels.join("");
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
};

const fixed2 = (value) => Number(value).toFixed(2);
const plain = (value) => String(Number(Number(value).toFixed(2)));

const heldFromOffer = (offer) => (offer
    ? { offerId: String(offer._id), companyName: offer.companyName || "another company", packageLpa: Number(offer.packageLpa) }
    : null);

/** The student's accepted/placed offer with the highest package (any academic year), or null. */
export const loadHeldOffer = async (studentId) => {
    if (!studentId) return null;
    const offer = await Offer.findOne({ student: studentId, status: { $in: HELD_OFFER_STATUSES } })
        .sort({ packageLpa: -1, updatedAt: -1 })
        .select("companyName packageLpa")
        .lean();
    return heldFromOffer(offer);
};

/** `{policy, held}` for a student in a college. */
export const loadPolicyContext = async (studentId, collegeId) => {
    const [policy, held] = await Promise.all([
        resolvePolicy(collegeId ?? null, academicYearFor()),
        loadHeldOffer(studentId),
    ]);
    return { policy, held };
};

const check = (key, label, required, actual, passed) => ({ key, label, required, actual, passed });

/**
 * Pure, synchronous eligibility of one student for one drive.
 * @param {{facts: object, job: object, policyContext?: {policy: object, held: object|null}}} input
 */
export const evaluateEligibility = ({ facts = {}, job = {}, policyContext = null }) => {
    const checks = [];
    const failures = [];
    const missing = [];

    const minimumCgpa = toNumber(job.minimumCgpa);
    if (minimumCgpa !== null) {
        const cgpa = toNumber(facts.cgpa);
        const passed = cgpa === null ? null : cgpa >= minimumCgpa;
        checks.push(check("cgpa", "Minimum CGPA", `>= ${fixed2(minimumCgpa)}`, cgpa === null ? null : fixed2(cgpa), passed));
        if (passed === null) missing.push("cgpa");
        else if (!passed) failures.push(`Your CGPA of ${fixed2(cgpa)} is below the required minimum of ${fixed2(minimumCgpa)}.`);
    }

    const maximumBacklogs = toNumber(job.maximumBacklogs);
    if (maximumBacklogs !== null) {
        const backlogs = toNumber(facts.activeBacklogs);
        const passed = backlogs === null ? null : backlogs <= maximumBacklogs;
        checks.push(check("backlogs", "Maximum active backlogs", `<= ${maximumBacklogs}`, backlogs === null ? null : String(backlogs), passed));
        if (passed === null) missing.push("activeBacklogs");
        else if (!passed) failures.push(`You have ${backlogs} active backlog(s); at most ${maximumBacklogs} allowed.`);
    }

    const branches = Array.isArray(job.eligibleBranches) ? job.eligibleBranches.filter((entry) => String(entry ?? "").trim()) : [];
    if (!isUnrestricted(branches)) {
        const branch = toText(facts.branch);
        const passed = branch === null ? null : branchMatches(branch, branches);
        checks.push(check("branch", "Eligible branches", branches.join(", "), branch, passed));
        if (passed === null) missing.push("branch");
        else if (!passed) failures.push(`Your branch (${branch}) is not among the eligible branches: ${branches.join(", ")}.`);
    }

    const years = (Array.isArray(job.graduationYears) ? job.graduationYears : []).map((year) => String(year).trim()).filter(Boolean);
    if (years.length > 0) {
        const parsedYear = Number.parseInt(facts.passingYear, 10);
        const passingYear = Number.isFinite(parsedYear) ? String(parsedYear) : null;
        const passed = passingYear === null ? null : years.includes(passingYear);
        checks.push(check("graduationYear", "Graduation year", years.join(", "), passingYear, passed));
        if (passed === null) missing.push("passingYear");
        else if (!passed) failures.push(`This drive is open to ${years.join(", ")} graduates; your passing year is ${passingYear}.`);
    }

    for (const [key, jobField, factField, label, ordinal] of [
        ["tenth", "min10thPercentage", "tenthPercentage", "Minimum 10th percentage", "10th"],
        ["twelfth", "min12thPercentage", "twelfthPercentage", "Minimum 12th percentage", "12th"],
    ]) {
        const minimum = toNumber(job[jobField]);
        if (minimum === null) continue;
        const value = toNumber(facts[factField]);
        const passed = value === null ? null : value >= minimum;
        checks.push(check(key, label, `>= ${plain(minimum)}%`, value === null ? null : `${plain(value)}%`, passed));
        if (passed === null) missing.push(factField);
        else if (!passed) failures.push(`Your ${ordinal} percentage (${plain(value)}%) is below the ${plain(minimum)}% cut-off.`);
    }

    const policy = policyContext?.policy || null;
    const held = policyContext?.held || null;
    const enforced = Boolean(policy?.enforceOneOffer);
    let policyCheck = null;
    let requiredPackageLpa = null;
    let policyReason = null;
    if (enforced && held) {
        requiredPackageLpa = round2(held.packageLpa * Number(policy.dreamMultiplier ?? 1.5));
        const jobPackage = toNumber(job.packageLpa);
        const passed = Boolean(policy.allowDreamUpgrade) && jobPackage !== null && jobPackage >= requiredPackageLpa;
        policyCheck = check(
            "policy.oneOffer",
            "One-offer policy",
            policy.allowDreamUpgrade ? `>= ${formatLpa(requiredPackageLpa)} LPA` : "No accepted offer",
            `${held.companyName} (${formatLpa(held.packageLpa)} LPA)`,
            passed,
        );
        checks.push(policyCheck);
        const accepted = `One-offer policy: you have already accepted ${held.companyName} (${formatLpa(held.packageLpa)} LPA)`;
        if (!passed) {
            if (!policy.allowDreamUpgrade) policyReason = `${accepted}, so you cannot apply to new drives.`;
            else if (jobPackage === null) policyReason = `${accepted}. This drive's package is not disclosed, so it cannot count as a dream upgrade.`;
            else policyReason = `${accepted}. Only drives offering at least ${formatLpa(requiredPackageLpa)} LPA are open to you.`;
        }
    }

    let status;
    let code;
    let reasons;
    if (failures.length > 0) {
        status = "ineligible";
        code = "NOT_ELIGIBLE";
        reasons = policyReason ? [...failures, policyReason] : failures;
    } else if (policyCheck && policyCheck.passed === false) {
        status = "ineligible";
        code = "POLICY_BLOCKED";
        reasons = [policyReason];
    } else if (missing.length > 0) {
        status = "incomplete";
        code = "PROFILE_INCOMPLETE";
        reasons = [`Add your ${joinLabels(missing.map((field) => MISSING_LABELS[field] || field))} to your profile to check eligibility.`];
    } else {
        status = "eligible";
        code = "ELIGIBLE";
        reasons = [];
    }

    return {
        eligible: status === "eligible",
        status,
        code,
        reasons,
        missing,
        checks,
        policy: {
            enforced,
            blocked: policyCheck?.passed === false,
            currentAcceptedPackage: held ? held.packageLpa : null,
            requiredPackageLpa,
            isDreamUpgrade: policyCheck?.passed === true,
        },
    };
};

const collegeKey = (value) => (value ? String(value._id ?? value) : "null");

/**
 * Eligibility of `user` for each job (one policy context per distinct college).
 * @returns {Promise<Map<string, object>>} keyed by job id string
 */
export const evaluateForJobs = async (user, jobs = []) => {
    const result = new Map();
    if (!user || jobs.length === 0) return result;
    const facts = studentFacts(user);
    const held = await loadHeldOffer(user._id);
    const year = academicYearFor();
    const policies = new Map();
    for (const job of jobs) {
        const college = job.college?._id ?? job.college ?? user.college ?? null;
        const key = collegeKey(college);
        if (!policies.has(key)) policies.set(key, await resolvePolicy(college, year));
        result.set(String(job._id), evaluateEligibility({ facts, job, policyContext: { policy: policies.get(key), held } }));
    }
    return result;
};

/** Eligibility for one job. */
export const evaluateForJob = async (user, job) => (await evaluateForJobs(user, [job])).get(String(job._id));

const STUDENT_FACT_FIELDS = "cgpa activeBacklogs branch passingYear tenthPercentage twelfthPercentage ggsipuLinked college";

/**
 * Active students in the job's college scope whose verdict is "eligible".
 * @param {object} job a Job (lean or document)
 * @param {{excludeApplied?: boolean}} [options] drop students with a live (non-withdrawn) application
 * @returns {Promise<string[]>} user id strings
 */
export const findEligibleStudentIds = async (job, { excludeApplied = false } = {}) => {
    if (!job) return [];
    const college = job.college?._id ?? job.college ?? null;
    const filter = { role: "student", isActive: { $ne: false } };
    if (college) filter.college = college;

    let excluded = new Set();
    if (excludeApplied) {
        const applied = await Application.distinct("student", { job: job._id, status: { $ne: "withdrawn" } });
        excluded = new Set(applied.map(String));
    }

    const heldRows = await Offer.aggregate([
        { $match: { status: { $in: HELD_OFFER_STATUSES } } },
        { $sort: { packageLpa: -1 } },
        { $group: { _id: "$student", offerId: { $first: "$_id" }, companyName: { $first: "$companyName" }, packageLpa: { $first: "$packageLpa" } } },
    ]);
    const heldByStudent = new Map(heldRows.map((row) => [String(row._id), heldFromOffer({ _id: row.offerId, ...row })]));

    const year = academicYearFor();
    const policyFor = createPolicyCache();
    const eligible = [];
    const cursor = User.find(filter).select(STUDENT_FACT_FIELDS).lean().cursor({ batchSize: 500 });
    for await (const student of cursor) {
        const id = String(student._id);
        if (excluded.has(id)) continue;
        const policy = await policyFor(college ?? student.college ?? null, year);
        const verdict = evaluateEligibility({
            facts: studentFacts(student),
            job,
            policyContext: { policy, held: heldByStudent.get(id) || null },
        });
        if (verdict.status === "eligible") eligible.push(id);
    }
    return eligible;
};

export const isValidId = (value) => mongoose.isValidObjectId(value);
