// Fuzzy references for the agent tools (docs/contracts/PLACEMENTS.md §12.1).
// Each resolver accepts a 24-hex id first; otherwise the text is resolved inside the caller's
// scope. Outcomes: the record, a 404, or {ambiguous:true, message, candidates:[{id,label}]} (≤ 8).
import { escapeRegex, fail, isObjectId } from "../../../core/http.js";
import { Job } from "../../../models/job.models.js";
import { Resume } from "../../../models/resume.models.js";
import { Application } from "../models/application.model.js";
import { Offer } from "../models/offer.model.js";
import { TrainingProgram } from "../models/training-program.model.js";
import { formatDay } from "../utils/dates.js";
import { loadApplicationInScope } from "./application.service.js";
import { COMPANY_POPULATE, loadJobInScope } from "./drive.service.js";
import { loadOfferInScope } from "./offer.service.js";
import { formatLpa } from "./package.js";
import { andFilters, applicationScope, collegeScope, offerScope, resolveJobScope } from "./scope.js";
import { audienceMatches, loadProgramInScope } from "./training.service.js";
import { companyOf, idOf } from "./views.js";

const MAX_CANDIDATES = 8;

const tokensOf = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
const matchesAllTokens = (haystack, tokens) => tokens.every((token) => new RegExp(escapeRegex(token), "i").test(haystack));
const normal = (text) => String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const isAmbiguous = (value) => Boolean(value) && value.ambiguous === true;
export { isAmbiguous };

/**
 * Pick one of the matches: 0 → 404, 1 → it, more → a unique exact label/title match, else ambiguous.
 */
const choose = (matches, { text, noun, exactKeys, label }) => {
    if (matches.length === 0) throw fail(404, `No ${noun} matches '${String(text).slice(0, 80)}'`, "NOT_FOUND");
    if (matches.length === 1) return matches[0];
    const wanted = normal(text);
    const exact = matches.filter((match) => exactKeys(match).some((key) => normal(key) === wanted));
    if (exact.length === 1) return exact[0];
    const pool = exact.length > 1 ? exact : matches;
    return {
        ambiguous: true,
        message: `Which ${noun} do you mean?`,
        candidates: pool.slice(0, MAX_CANDIDATES).map((match) => ({ id: idOf(match._id), label: label(match) })),
    };
};

// ── Drives ──────────────────────────────────────────────────────────────────

export const driveLabel = (job) => {
    const deadline = job.applicationDeadline ? `, apply by ${formatDay(job.applicationDeadline)}` : "";
    return `${companyOf(job).name} – ${job.title} (${job.status || "active"}${deadline})`;
};

const jobHaystack = (job) => `${companyOf(job).name} ${job.title}`;

/** Text match among already-loaded drives (prefers `prefer` statuses). */
const pickDrive = (jobs, text, { prefer = ["active"] } = {}) => {
    const tokens = tokensOf(text);
    let matches = jobs.filter((job) => matchesAllTokens(jobHaystack(job), tokens));
    const preferred = matches.filter((job) => prefer.includes(job.status || "active"));
    if (preferred.length > 0) matches = preferred;
    return choose(matches, {
        text,
        noun: "drive",
        exactKeys: (job) => [job.title, `${companyOf(job).name} ${job.title}`, `${companyOf(job).name} – ${job.title}`, `${companyOf(job).name} - ${job.title}`],
        label: driveLabel,
    });
};

/**
 * A drive in the caller's scope by id or "company title" text.
 * @returns {Promise<object>} lean job (company populated) or an ambiguous answer
 */
export const resolveJobRef = async (user, ref, { prefer = ["active"] } = {}) => {
    const text = String(ref ?? "").trim();
    if (!text) throw fail(400, "Name the drive (company and role) or give its id", "VALIDATION", { field: "job" });
    if (isObjectId(text)) return loadJobInScope(user, text, { lean: true });
    const scope = await resolveJobScope(user);
    const jobs = await Job.find(scope).populate(COMPANY_POPULATE).sort({ createdAt: -1 }).limit(1000).lean();
    return pickDrive(jobs, text, { prefer });
};

// ── Applications ────────────────────────────────────────────────────────────

const APPLICATION_POPULATE = [
    { path: "job", select: "title company status applicationDeadline college", populate: { path: "company", select: "name" } },
    { path: "student", select: "name email rollNumber ggsipuEnrollment branch cgpa" },
];

export const applicationLabel = (application) => {
    const job = application.job || {};
    const student = application.student?.name || "Student";
    return `${student} – ${companyOf(job).name} ${job.title || ""} (${application.status})`.replace(/\s+\(/, " (");
};

const studentMatches = (student, text) => {
    if (!student) return false;
    const value = normal(text);
    if (!value) return true;
    if (normal(student.email) === value) return true;
    if (student.rollNumber && normal(student.rollNumber) === value) return true;
    if (student.ggsipuEnrollment && normal(student.ggsipuEnrollment) === value) return true;
    return matchesAllTokens(student.name || "", tokensOf(text));
};

/**
 * An application in the caller's scope. Students: by drive text among their own applications.
 * Staff: "<student>" or "<student> for|@|at <drive>".
 */
export const resolveApplicationRef = async (user, ref, { statuses } = {}) => {
    const text = String(ref ?? "").trim();
    if (!text) throw fail(400, "Name the application (student and/or drive) or give its id", "VALIDATION", { field: "application" });
    if (isObjectId(text)) return loadApplicationInScope(user, text, { populate: APPLICATION_POPULATE });
    const filter = andFilters(applicationScope(user), statuses ? { status: { $in: statuses } } : {});
    const rows = await Application.find(filter).populate(APPLICATION_POPULATE).sort({ updatedAt: -1 }).limit(2000).lean();
    let matches;
    if (user.role === "student") {
        const tokens = tokensOf(text);
        matches = rows.filter((row) => row.job && matchesAllTokens(jobHaystack(row.job), tokens));
    } else {
        const [studentPart, jobPart] = text.split(/\s+(?:for|@|at)\s+/i);
        matches = rows.filter((row) => studentMatches(row.student, studentPart)
            && (!jobPart || (row.job && matchesAllTokens(jobHaystack(row.job), tokensOf(jobPart)))));
    }
    const live = matches.filter((row) => !["withdrawn"].includes(row.status));
    if (live.length > 0) matches = live;
    return choose(matches, {
        text,
        noun: "application",
        exactKeys: (row) => [row.student?.email, row.student?.name, row.job?.title, row.job ? `${companyOf(row.job).name} ${row.job.title}` : ""].filter(Boolean),
        label: applicationLabel,
    });
};

/** The student's applications matching a drive text (application_withdraw by `job`). */
export const resolveOwnApplicationByJob = async (user, jobText) => {
    const tokens = tokensOf(jobText);
    const rows = await Application.find({ student: user._id }).populate(APPLICATION_POPULATE).sort({ updatedAt: -1 }).lean();
    let matches = rows.filter((row) => row.job && matchesAllTokens(jobHaystack(row.job), tokens));
    const live = matches.filter((row) => ["applied", "shortlisted", "interview", "offered"].includes(row.status));
    if (live.length > 0) matches = live;
    return choose(matches, {
        text: jobText,
        noun: "application",
        exactKeys: (row) => [row.job?.title, row.job ? `${companyOf(row.job).name} ${row.job.title}` : ""].filter(Boolean),
        label: applicationLabel,
    });
};

/** The student's only live application, or an ambiguous answer listing them. */
export const resolveOnlyLiveApplication = async (user) => {
    const rows = await Application.find({ student: user._id, status: { $in: ["applied", "shortlisted", "interview", "offered"] } })
        .populate(APPLICATION_POPULATE).sort({ updatedAt: -1 }).lean();
    if (rows.length === 0) throw fail(404, "You have no active applications to withdraw", "NOT_FOUND");
    if (rows.length === 1) return rows[0];
    return {
        ambiguous: true,
        message: "Which application do you mean?",
        candidates: rows.slice(0, MAX_CANDIDATES).map((row) => ({ id: idOf(row._id), label: applicationLabel(row) })),
    };
};

// ── Offers ──────────────────────────────────────────────────────────────────

export const offerLabel = (offer) => `${offer.companyName} – ${formatLpa(offer.packageLpa)} LPA (${offer.status})`;

/** An offer by id, or by company/role text among the caller's offers (prefers extended). */
export const resolveOfferRef = async (user, ref) => {
    const text = String(ref ?? "").trim();
    if (!text) throw fail(400, "Name the offer (company) or give its id", "VALIDATION", { field: "offer" });
    if (isObjectId(text)) return loadOfferInScope(user, text);
    const offers = await Offer.find(offerScope(user)).populate({ path: "job", select: "title" }).sort({ updatedAt: -1 }).limit(500).lean();
    const tokens = tokensOf(text);
    let matches = offers.filter((offer) => matchesAllTokens(`${offer.companyName} ${offer.roleTitle} ${offer.job?.title || ""}`, tokens));
    const extended = matches.filter((offer) => offer.status === "extended");
    if (extended.length > 0) matches = extended;
    return choose(matches, {
        text,
        noun: "offer",
        exactKeys: (offer) => [offer.companyName, offer.roleTitle, `${offer.companyName} ${offer.roleTitle}`],
        label: offerLabel,
    });
};

/** The student's only extended offer, or an ambiguous answer. */
export const resolveOnlyPendingOffer = async (user) => {
    const offers = await Offer.find({ student: user._id, status: "extended" }).sort({ expiresAt: 1 }).lean();
    if (offers.length === 0) throw fail(404, "You have no pending offers", "NOT_FOUND");
    if (offers.length === 1) return offers[0];
    return {
        ambiguous: true,
        message: "Which offer do you mean?",
        candidates: offers.slice(0, MAX_CANDIDATES).map((offer) => ({ id: idOf(offer._id), label: offerLabel(offer) })),
    };
};

// ── Training ────────────────────────────────────────────────────────────────

export const programLabel = (program) => {
    const first = [...(program.schedule || [])].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
    return `${program.title} (starts ${first ? formatDay(first.date) : "TBA"})`;
};

/** A visible upcoming/ongoing program by id or title text. */
export const resolveProgramRef = async (user, ref) => {
    const text = String(ref ?? "").trim();
    if (!text) throw fail(400, "Name the training program or give its id", "VALIDATION", { field: "program" });
    if (isObjectId(text)) return loadProgramInScope(user, text);
    const programs = await TrainingProgram.find(andFilters(collegeScope(user), {
        status: { $in: ["upcoming", "ongoing"] },
        title: new RegExp(escapeRegex(text), "i"),
    })).limit(200).lean();
    let matches = programs;
    if (user.role === "student") matches = matches.filter((program) => audienceMatches(program, user));
    if (matches.length === 0) {
        const tokens = tokensOf(text);
        const all = await TrainingProgram.find(andFilters(collegeScope(user), { status: { $in: ["upcoming", "ongoing"] } })).limit(500).lean();
        matches = all.filter((program) => matchesAllTokens(program.title, tokens)
            && (user.role !== "student" || audienceMatches(program, user)));
    }
    return choose(matches, {
        text,
        noun: "training program",
        exactKeys: (program) => [program.title],
        label: programLabel,
    });
};

// ── Resumes ─────────────────────────────────────────────────────────────────

/** A resume id: an id, or the case-insensitive exact title of one of the student's active resumes. */
export const resolveResumeRef = async (user, ref) => {
    const text = String(ref ?? "").trim();
    if (!text) return undefined;
    if (isObjectId(text)) return text;
    const resumes = await Resume.find({ owner: user._id, status: "active", title: new RegExp(`^${escapeRegex(text)}$`, "i") })
        .select("_id title version").sort({ version: -1 }).lean();
    if (resumes.length === 0) throw fail(404, `No active resume is titled '${text.slice(0, 80)}'`, "RESUME_NOT_FOUND");
    return String(resumes[0]._id);
};
