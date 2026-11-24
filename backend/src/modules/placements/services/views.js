// Every response shape of the placements module (docs/contracts/PLACEMENTS.md §5).
// Ids are strings, dates ISO strings. Internal job fields (applications, sourceSessionId,
// sourceDraftKey, notifiedAt, deadlineReminderSentAt, __v) are never output, and a
// student-facing view never contains another student's data.
import { DateTime } from "luxon";
import {
    APPLICATION_STATUSES,
    OFFER_STATUSES,
    offerStatusLabel,
    statusLabel,
} from "../constants.js";
import { TIMEZONE, clock, toIso } from "../utils/dates.js";
import { packageLabel } from "./package.js";

export const idOf = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (value._id !== undefined && value._id !== value) return idOf(value._id);
    return typeof value.toString === "function" ? value.toString() : String(value);
};

const plainOf = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);
const arr = (value) => (Array.isArray(value) ? value : []);
const nullable = (value) => (value === undefined ? null : value);

export const emptyApplicationCounts = () => Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0]));
export const emptyOfferCounts = () => Object.fromEntries(OFFER_STATUSES.map((status) => [status, 0]));

// ── Jobs ────────────────────────────────────────────────────────────────────

export const companyOf = (job) => {
    const company = job?.company;
    if (company && typeof company === "object" && company.name !== undefined) {
        return { _id: idOf(company._id), name: company.name || "Unknown Company" };
    }
    return { _id: null, name: "Unknown Company" };
};

export const jobStatus = (job) => job?.status || "active";

/** Accepting applications right now. A legacy drive without a deadline counts as open. */
export const isDriveOpen = (job, now = clock.now()) => {
    if (jobStatus(job) !== "active") return false;
    if (!job.applicationDeadline) return true;
    return new Date(job.applicationDeadline).getTime() > now.getTime();
};

const roundView = (round) => ({
    _id: idOf(round._id),
    name: round.name,
    at: toIso(round.at),
    venue: round.venue || "",
    mode: round.mode || "offline",
    notes: round.notes || "",
});

/** JobView (every role). */
export const toJobView = (doc, { now = clock.now() } = {}) => {
    const job = plainOf(doc);
    const company = companyOf(job);
    const skills = arr(job.skills);
    const deadline = toIso(job.applicationDeadline);
    return {
        _id: idOf(job._id),
        title: job.title,
        roleTitle: job.title,
        description: job.description || "",
        company,
        companyName: company.name,
        companyLogo: job.companyLogo || null,
        salary: job.salary || "not disclosed",
        packageLpa: nullable(job.packageLpa),
        packageMaxLpa: nullable(job.packageMaxLpa),
        packageLabel: packageLabel(job),
        location: job.location || "",
        employmentType: job.employmentType || "",
        skills,
        skillsRequired: skills,
        eligibleBranches: arr(job.eligibleBranches),
        minimumCgpa: nullable(job.minimumCgpa),
        minCgpa: nullable(job.minimumCgpa),
        maximumBacklogs: nullable(job.maximumBacklogs),
        graduationYears: arr(job.graduationYears).map(String),
        min10thPercentage: nullable(job.min10thPercentage),
        min12thPercentage: nullable(job.min12thPercentage),
        selectionProcess: job.selectionProcess || "",
        rounds: arr(job.rounds).map(roundView),
        applicationDeadline: deadline,
        deadline,
        driveDate: toIso(job.driveDate),
        status: jobStatus(job),
        isOpen: isDriveOpen(job, now),
        applicationUrl: null,
        publishedAt: toIso(job.publishedAt),
        createdAt: toIso(job.createdAt),
        updatedAt: toIso(job.updatedAt),
    };
};

const myApplicationView = (application) => (application
    ? {
        _id: idOf(application._id),
        status: application.status,
        statusLabel: statusLabel(application.status),
        appliedAt: toIso(application.appliedAt),
        updatedAt: toIso(application.updatedAt),
    }
    : null);

const BLOCK_MESSAGES = Object.freeze({
    DRIVE_NOT_OPEN: "This drive is not open for applications.",
    DEADLINE_PASSED: "The application deadline has passed.",
    ALREADY_APPLIED: "You have already applied to this drive.",
});

/** `{canApply, applyBlockedCode, applyBlockedReason}` for a student. */
export const applyState = (job, { eligibility, application, now = clock.now() }) => {
    if (jobStatus(job) !== "active") return { canApply: false, applyBlockedCode: "DRIVE_NOT_OPEN", applyBlockedReason: BLOCK_MESSAGES.DRIVE_NOT_OPEN };
    if (!isDriveOpen(job, now)) return { canApply: false, applyBlockedCode: "DEADLINE_PASSED", applyBlockedReason: BLOCK_MESSAGES.DEADLINE_PASSED };
    if (application && application.status !== "withdrawn") {
        return {
            canApply: false,
            applyBlockedCode: "ALREADY_APPLIED",
            applyBlockedReason: application.status === "rejected"
                ? "Your earlier application to this drive was not selected."
                : BLOCK_MESSAGES.ALREADY_APPLIED,
        };
    }
    if (eligibility && !eligibility.eligible) {
        return { canApply: false, applyBlockedCode: eligibility.code, applyBlockedReason: eligibility.reasons[0] || "" };
    }
    return { canApply: true, applyBlockedCode: null, applyBlockedReason: "" };
};

/** StudentJobView = JobView + the viewer's eligibility, skill match and application. */
export const toStudentJobView = (doc, { eligibility, match, application, now = clock.now() }) => {
    const job = plainOf(doc);
    const base = toJobView(job, { now });
    const myApplication = myApplicationView(application);
    return {
        ...base,
        eligibility,
        isEligible: Boolean(eligibility?.eligible),
        eligibilityReason: eligibility?.reasons?.[0] || "",
        matchPercentage: match?.matchPercentage ?? null,
        matchedSkills: match?.matchedSkills ?? [],
        missingSkills: match?.missingSkills ?? [],
        myApplication,
        applicationStatus: myApplication?.status ?? null,
        applicationStatusLabel: myApplication?.statusLabel ?? null,
        ...applyState(job, { eligibility, application, now }),
    };
};

const reviewView = (review) => (review && review.decision
    ? { decision: review.decision, by: idOf(review.by), byName: review.byName || "", at: toIso(review.at), note: review.note || "" }
    : null);

const personRef = (person) => (person && typeof person === "object" && person.name !== undefined
    ? { _id: idOf(person._id), name: person.name, role: person.role || null }
    : null);

/** StaffJobView (tpo, admin, company) = JobView + review/audit fields and applicant counts. */
export const toStaffJobView = (doc, { counts, now = clock.now() } = {}) => {
    const job = plainOf(doc);
    const statusCounts = { ...emptyApplicationCounts(), ...(counts || {}) };
    const applicantCount = Object.entries(statusCounts)
        .filter(([status]) => status !== "withdrawn")
        .reduce((sum, [, count]) => sum + count, 0);
    return {
        ...toJobView(job, { now }),
        college: idOf(job.college),
        createdBy: personRef(job.createdBy),
        createdByRole: job.createdByRole || "tpo",
        review: reviewView(job.review),
        closedAt: toIso(job.closedAt),
        closedReason: job.closedReason || null,
        applicantCount,
        statusCounts,
    };
};

/** AgentJobSummary (tool data.jobs[]); keys follow JOB-FEED §12.5 campus_item. */
export const toAgentJobSummary = (doc, { viewer, eligibility, match, application, counts } = {}) => {
    const job = plainOf(doc);
    const company = companyOf(job);
    const label = packageLabel(job);
    const id = idOf(job._id);
    const summary = {
        id,
        _id: id,
        title: job.title,
        company,
        companyName: company.name,
        companyLogo: job.companyLogo || null,
        salary: label,
        packageLpa: nullable(job.packageLpa),
        packageLabel: label,
        location: job.location || "",
        employmentType: job.employmentType || "",
        skills: arr(job.skills),
        description: String(job.description || "").slice(0, 1200),
        minimumCgpa: nullable(job.minimumCgpa),
        maximumBacklogs: nullable(job.maximumBacklogs),
        eligibleBranches: arr(job.eligibleBranches),
        graduationYears: arr(job.graduationYears).map(String),
        selectionProcess: job.selectionProcess || "",
        applicationUrl: null,
        createdAt: toIso(job.createdAt),
        applicationDeadline: toIso(job.applicationDeadline),
        driveDate: toIso(job.driveDate),
        status: jobStatus(job),
    };
    if (viewer?.role === "student") {
        const mine = application
            ? { _id: idOf(application._id), status: application.status, statusLabel: statusLabel(application.status) }
            : null;
        Object.assign(summary, {
            isEligible: Boolean(eligibility?.eligible),
            eligibilityReason: eligibility?.reasons?.[0] || "",
            eligibilityReasons: (eligibility?.reasons || []).slice(0, 3),
            matchScore: match?.matchPercentage ?? null,
            matchPercentage: match?.matchPercentage ?? null,
            matchedSkills: match?.matchedSkills ?? [],
            myApplication: mine,
            applicationStatus: mine?.status ?? null,
        });
    } else if (["tpo", "admin", "company"].includes(viewer?.role)) {
        const statusCounts = { ...emptyApplicationCounts(), ...(counts || {}) };
        summary.applicantCount = Object.entries(statusCounts)
            .filter(([status]) => status !== "withdrawn")
            .reduce((sum, [, count]) => sum + count, 0);
    }
    return summary;
};

// ── Applications ────────────────────────────────────────────────────────────

const offerRef = (offer) => (offer && typeof offer === "object" && offer.status !== undefined
    ? { _id: idOf(offer._id), status: offer.status, packageLpa: nullable(offer.packageLpa) }
    : null);

const resumeRef = (resume) => (resume && resume.id ? { id: idOf(resume.id), title: resume.title || "" } : null);

const jobCompanyName = (job) => companyOf(job).name;

/** ApplicationStudentView (the owner student). */
export const toApplicationStudentView = (doc) => {
    const application = plainOf(doc);
    const job = application.job && typeof application.job === "object" && application.job.title !== undefined ? application.job : null;
    const snapshot = application.eligibilitySnapshot || {};
    return {
        _id: idOf(application._id),
        status: application.status,
        statusLabel: statusLabel(application.status),
        appliedAt: toIso(application.appliedAt),
        updatedAt: toIso(application.updatedAt),
        withdrawnAt: toIso(application.withdrawnAt),
        job: job
            ? {
                _id: idOf(job._id),
                title: job.title,
                companyName: jobCompanyName(job),
                packageLabel: packageLabel(job),
                location: job.location || "",
                applicationDeadline: toIso(job.applicationDeadline),
                driveDate: toIso(job.driveDate),
                status: jobStatus(job),
            }
            : { _id: idOf(application.job), title: "Drive removed", companyName: "Unknown Company", packageLabel: "Not disclosed", location: "", applicationDeadline: null, driveDate: null, status: "closed" },
        timeline: arr(application.timeline).map((entry) => ({ status: entry.status, at: toIso(entry.at), note: entry.note || "" })),
        resume: resumeRef(application.resume),
        coverNote: application.coverNote || "",
        eligibilitySnapshot: {
            eligible: nullable(snapshot.eligible),
            status: snapshot.status || "unknown",
            reasons: arr(snapshot.reasons),
        },
        offer: offerRef(application.offer),
    };
};

const isPolicyReason = (reason) => /^One-offer policy:/i.test(String(reason || ""));

/** The eligibility snapshot without anything derived from the student's other offers. */
const snapshotForRecruiter = (snapshot) => {
    if (!snapshot) return null;
    const { policy, ...rest } = snapshot;
    return {
        ...rest,
        code: rest.code === "POLICY_BLOCKED" ? null : nullable(rest.code),
        reasons: arr(rest.reasons).filter((reason) => !isPolicyReason(reason)),
        checks: arr(rest.checks).filter((entry) => entry.key !== "policy.oneOffer"),
    };
};

const snapshotView = (snapshot) => (snapshot
    ? {
        eligible: nullable(snapshot.eligible),
        status: snapshot.status || "unknown",
        code: nullable(snapshot.code),
        reasons: arr(snapshot.reasons),
        missing: arr(snapshot.missing),
        checks: arr(snapshot.checks).map((entry) => ({
            key: entry.key, label: entry.label, required: entry.required, actual: nullable(entry.actual), passed: nullable(entry.passed),
        })),
        policy: snapshot.policy ? { ...snapshot.policy } : null,
        profile: snapshot.profile ? { ...snapshot.profile } : null,
        evaluatedAt: toIso(snapshot.evaluatedAt),
    }
    : null);

const studentRef = (student) => {
    if (!student || typeof student !== "object" || student.name === undefined) {
        return { _id: idOf(student), name: "Unknown student", email: "", rollNumber: "", ggsipuEnrollment: "", branch: "", section: "", semester: null, passingYear: "", cgpa: null, activeBacklogs: null, skills: [] };
    }
    return {
        _id: idOf(student._id),
        name: student.name,
        email: student.email || "",
        rollNumber: student.rollNumber || "",
        ggsipuEnrollment: student.ggsipuEnrollment || "",
        branch: student.branch || "",
        section: student.section || "",
        semester: nullable(student.semester),
        passingYear: student.passingYear || "",
        cgpa: nullable(student.cgpa),
        activeBacklogs: nullable(student.activeBacklogs),
        skills: arr(student.skills).slice(0, 20),
    };
};

/** ApplicationStaffView (tpo/admin/company). Company viewers never see policy-derived data. */
export const toApplicationStaffView = (doc, { viewer } = {}) => {
    const application = plainOf(doc);
    const job = application.job && typeof application.job === "object" && application.job.title !== undefined ? application.job : null;
    const snapshot = snapshotView(application.eligibilitySnapshot);
    const override = application.eligibilityOverride;
    return {
        _id: idOf(application._id),
        status: application.status,
        statusLabel: statusLabel(application.status),
        appliedAt: toIso(application.appliedAt),
        updatedAt: toIso(application.updatedAt),
        source: application.source || "web",
        job: job
            ? { _id: idOf(job._id), title: job.title, companyName: jobCompanyName(job) }
            : { _id: idOf(application.job), title: "Drive removed", companyName: "Unknown Company" },
        student: studentRef(application.student),
        eligibilitySnapshot: viewer?.role === "company" ? snapshotForRecruiter(snapshot) : snapshot,
        eligibilityOverride: override && override.at
            ? { by: idOf(override.by), byName: override.byName || "", at: toIso(override.at), note: override.note || "" }
            : null,
        resume: resumeRef(application.resume),
        coverNote: application.coverNote || "",
        timeline: arr(application.timeline).map((entry) => ({
            status: entry.status, at: toIso(entry.at), byName: entry.byName || "", byRole: entry.byRole || "", note: entry.note || "",
        })),
        offer: offerRef(application.offer),
    };
};

// ── Offers ──────────────────────────────────────────────────────────────────

/**
 * OfferStudentView. `computed` = {currentAcceptedPackage, dreamMultiplier, isDreamEligible}.
 */
export const toOfferStudentView = (doc, computed = {}) => {
    const offer = plainOf(doc);
    const job = offer.job && typeof offer.job === "object" && offer.job.title !== undefined ? offer.job : null;
    return {
        _id: idOf(offer._id),
        status: offer.status,
        statusLabel: offerStatusLabel(offer.status),
        offerType: offer.offerType || "normal",
        companyName: offer.companyName,
        roleTitle: offer.roleTitle,
        packageLpa: offer.packageLpa,
        expiresAt: toIso(offer.expiresAt),
        joiningDate: toIso(offer.joiningDate),
        location: offer.location || "",
        offerLetterUrl: offer.offerLetterUrl || null,
        academicYear: offer.academicYear,
        tpoOverride: Boolean(offer.tpoOverride),
        statusHistory: arr(offer.statusHistory).map((entry) => ({ status: entry.status, changedAt: toIso(entry.changedAt), note: entry.note || "" })),
        isDreamEligible: Boolean(computed.isDreamEligible),
        currentAcceptedPackage: nullable(computed.currentAcceptedPackage),
        dreamMultiplier: computed.dreamMultiplier ?? 1.5,
        job: job ? { _id: idOf(job._id), title: job.title } : (offer.job ? { _id: idOf(offer.job), title: offer.roleTitle } : null),
        createdAt: toIso(offer.createdAt),
        updatedAt: toIso(offer.updatedAt),
    };
};

/** OfferStaffView = OfferStudentView + student, audit and response fields. */
export const toOfferStaffView = (doc, computed = {}, { viewer } = {}) => {
    const offer = plainOf(doc);
    const student = offer.student && typeof offer.student === "object" && offer.student.name !== undefined ? offer.student : null;
    const base = toOfferStudentView(offer, viewer?.role === "company"
        ? { dreamMultiplier: computed.dreamMultiplier }
        : computed);
    return {
        ...base,
        student: student
            ? {
                _id: idOf(student._id),
                name: student.name,
                email: student.email || "",
                branch: student.branch || "",
                cgpa: nullable(student.cgpa),
                rollNumber: student.rollNumber || "",
                passingYear: student.passingYear || "",
            }
            : { _id: idOf(offer.student), name: "Unknown student", email: "", branch: "", cgpa: null, rollNumber: "", passingYear: "" },
        application: idOf(offer.application),
        createdBy: personRef(offer.createdBy),
        createdByRole: offer.createdByRole || null,
        responseReason: offer.responseReason || "",
        statusHistory: arr(offer.statusHistory).map((entry) => ({
            status: entry.status, changedAt: toIso(entry.changedAt), note: entry.note || "", byName: entry.byName || "", byRole: entry.byRole || "",
        })),
    };
};

// ── Policy ──────────────────────────────────────────────────────────────────

export const toPolicyView = (policy) => ({
    _id: idOf(policy._id),
    college: idOf(policy.college),
    academicYear: policy.academicYear,
    enforceOneOffer: Boolean(policy.enforceOneOffer),
    allowDreamUpgrade: Boolean(policy.allowDreamUpgrade),
    dreamMultiplier: policy.dreamMultiplier,
    superDreamMultiplier: policy.superDreamMultiplier,
    maxPendingOffers: policy.maxPendingOffers,
    offerExpiryDays: policy.offerExpiryDays,
    isActive: policy.isActive !== false,
    isDefault: Boolean(policy.isDefault),
    updatedAt: toIso(policy.updatedAt),
    updatedBy: policy.updatedBy && typeof policy.updatedBy === "object" && policy.updatedBy.name !== undefined
        ? { _id: idOf(policy.updatedBy._id), name: policy.updatedBy.name }
        : (policy.updatedBy ? { _id: idOf(policy.updatedBy), name: "" } : null),
});

// ── Training ────────────────────────────────────────────────────────────────

const sessionView = (session) => ({
    _id: idOf(session._id),
    date: toIso(session.date),
    time: session.time || "",
    venue: session.venue || "TBA",
    topic: session.topic || "",
    durationMinutes: nullable(session.durationMinutes),
});

/** The first session dated today or later (APP_TIMEZONE), otherwise the last one. */
export const nextSessionOf = (schedule, now = clock.now()) => {
    const sessions = arr(schedule);
    if (sessions.length === 0) return null;
    const today = DateTime.fromJSDate(now).setZone(TIMEZONE).startOf("day").toMillis();
    const upcoming = sessions.find((session) => new Date(session.date).getTime() >= today) || sessions[sessions.length - 1];
    return { date: toIso(upcoming.date), time: upcoming.time || "", venue: upcoming.venue || "TBA", topic: upcoming.topic || "" };
};

export const toProgramView = (doc, { isRegistered, now = clock.now() } = {}) => {
    const program = plainOf(doc);
    const schedule = [...arr(program.schedule)].sort((a, b) => new Date(a.date) - new Date(b.date));
    const capacity = Math.max(1, Number(program.capacity) || 1);
    const enrolled = Math.max(0, Number(program.enrolledCount) || 0);
    const view = {
        _id: idOf(program._id),
        title: program.title,
        description: program.description || "",
        type: program.type || "other",
        instructor: program.instructor || "",
        deliveryMode: program.deliveryMode || "offline",
        capacity,
        enrolledCount: enrolled,
        seatsLeft: Math.max(0, capacity - enrolled),
        status: String(program.status || "upcoming"),
        schedule: schedule.map(sessionView),
        nextSession: nextSessionOf(schedule, now),
        registrationDeadline: toIso(program.registrationDeadline),
        audience: {
            branches: arr(program.audience?.branches),
            graduationYears: arr(program.audience?.graduationYears).map(String),
            minCgpa: nullable(program.audience?.minCgpa),
        },
        cancelReason: program.cancelReason || "",
        createdAt: toIso(program.createdAt),
    };
    if (isRegistered !== undefined) view.isRegistered = Boolean(isRegistered);
    return view;
};

const attendanceView = (entry) => ({
    sessionIndex: entry.sessionIndex,
    date: toIso(entry.date),
    markedAt: toIso(entry.markedAt),
    method: entry.method || "manual",
});

export const toEnrollmentView = (doc, { now = clock.now() } = {}) => {
    const enrollment = plainOf(doc);
    const program = enrollment.program && typeof enrollment.program === "object" && enrollment.program.title !== undefined
        ? toProgramView(enrollment.program, { now, isRegistered: enrollment.status === "registered" })
        : null;
    return {
        _id: idOf(enrollment._id),
        program,
        status: enrollment.status || "registered",
        completionStatus: enrollment.completionStatus || "enrolled",
        attendance: arr(enrollment.attendance).map(attendanceView),
        registeredAt: toIso(enrollment.registeredAt),
        certificateUrl: enrollment.certificateUrl || null,
    };
};

export const toRosterEntryView = (doc) => {
    const enrollment = plainOf(doc);
    const student = enrollment.student && typeof enrollment.student === "object" && enrollment.student.name !== undefined
        ? enrollment.student
        : null;
    return {
        _id: idOf(enrollment._id),
        student: student
            ? { _id: idOf(student._id), name: student.name, email: student.email || "", branch: student.branch || "", passingYear: student.passingYear || "", rollNumber: student.rollNumber || "" }
            : { _id: idOf(enrollment.student), name: "Unknown student", email: "", branch: "", passingYear: "", rollNumber: "" },
        status: enrollment.status || "registered",
        completionStatus: enrollment.completionStatus || "enrolled",
        attendance: arr(enrollment.attendance).map(attendanceView),
        registeredAt: toIso(enrollment.registeredAt),
        certificateUrl: enrollment.certificateUrl || null,
    };
};
