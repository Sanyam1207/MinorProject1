// Copilot tools of the placements module (docs/contracts/PLACEMENTS.md §12, AGENT-TOOLS.md §2/§5).
// Handlers call the same services as the REST routes. confirm:true tools implement preview(),
// which runs every read-only check and returns args normalised to resolved ids.
import { fail } from "../../core/http.js";
import { APPLICATION_STATUSES, STAFF_SETTABLE_STATUSES, isStaff, offerStatusLabel, statusLabel } from "./constants.js";
import { Company } from "../../models/company.models.js";
import { academicYearFor } from "./services/academic-year.js";
import { resolveAnnouncementAudience, sendAnnouncement, normalizeAnnouncement } from "./services/announce.service.js";
import {
    applyToDrive,
    changeApplicationStatus,
    checkApply,
    checkStatusChange,
    checkWithdraw,
    listApplicantsForAgent,
    listMyApplications,
    withdrawApplication,
} from "./services/application.service.js";
import {
    buildAgentSummaries,
    closeDrive,
    createDrive,
    listDrivesForAgent,
    normalizeDriveInput,
    publishDrive,
    rejectDrive,
    searchCampusDrives,
    viewJobFor,
} from "./services/drive.service.js";
import { findEligibleStudentIds } from "./services/eligibility.service.js";
import {
    acceptOffer,
    checkAccept,
    createOffer,
    listMyOffers,
    listOffers,
    prepareOffer,
    rejectOffer,
} from "./services/offer.service.js";
import { formatLpa, packageLabel, round2 } from "./services/package.js";
import {
    isAmbiguous,
    resolveApplicationRef,
    resolveJobRef,
    resolveOfferRef,
    resolveOnlyLiveApplication,
    resolveOnlyPendingOffer,
    resolveOwnApplicationByJob,
    resolveProgramRef,
    resolveResumeRef,
} from "./services/resolve.js";
import { computeStats } from "./services/stats.service.js";
import { checkRegistration, listMyEnrollments, listPrograms, registerForProgram } from "./services/training.service.js";
import { companyOf, idOf } from "./services/views.js";
import { clock, formatDateTime, formatDay, toIso } from "./utils/dates.js";

const ALL_ROLES = ["student", "teacher", "tpo", "admin", "company", "alumni"];
const STAFF_AND_COMPANY = ["tpo", "admin", "company"];
const SUMMARY_MAX = 600;

const clip = (text, max = SUMMARY_MAX) => {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const plural = (count, noun, pluralNoun = `${noun}s`) => `${count} ${count === 1 ? noun : pluralNoun}`;
const compact = (params) => Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
const driveName = (job) => `${companyOf(job).name} – ${job.title}`;
const isCompany = (ctx) => ctx.user?.role === "company";

const drivesPanel = (ctx, params = {}) => ({ panel: isCompany(ctx) ? "company.drives" : "tpo.drives", params: compact(params) });
const applicantsPanel = (ctx, params = {}) => ({ panel: isCompany(ctx) ? "company.applicants" : "tpo.applicants", params: compact(params) });

// ── Students: drives ────────────────────────────────────────────────────────

const jobsSearchCampus = {
    name: "jobs_search_campus",
    description: "Search open campus placement drives (on-campus recruitment) in the user's college. Students get each drive's eligibility verdict, skill match and their application status; staff and recruiters get applicant counts.",
    roles: ["student", "tpo", "admin", "company"],
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "Keywords: company, role, skill or location, e.g. 'google sde' or 'react'" },
            location: { type: "string", description: "City or 'remote'" },
            minPackageLpa: { type: "number", minimum: 0, maximum: 500, description: "Minimum package in LPA" },
            eligibleOnly: { type: "boolean", description: "Students: only drives they are eligible for" },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        },
    },
    handler: async (args, ctx) => {
        const user = ctx.user;
        const { jobs, total } = await searchCampusDrives(user, { ...args, limit: args.limit ?? 8 });
        const top = jobs.slice(0, 3).map((job) => `${job.companyName} – ${job.title} (${job.packageLabel}${job.applicationDeadline ? `, apply by ${formatDay(job.applicationDeadline)}` : ""})`).join("; ");
        let summary;
        if (total === 0) summary = args.query ? `No open campus drives match "${args.query}".` : "No open campus drives right now.";
        else if (user.role === "student") {
            const eligible = jobs.filter((job) => job.isEligible).length;
            summary = `Found ${plural(total, "open campus drive")} (${eligible} you're eligible for): ${top}.`;
        } else summary = `Found ${plural(total, "open campus drive")}: ${top}.`;
        let ui;
        if (user.role === "student") {
            ui = { panel: "jobs.campus", params: compact({ query: args.query, location: args.location, minPackageLpa: args.minPackageLpa, eligibleOnly: args.eligibleOnly }) };
        } else ui = drivesPanel(ctx, { query: args.query });
        return { summary: clip(summary), data: { jobs }, ui };
    },
};

const jobDetails = {
    name: "job_details",
    description: "Show one campus drive: package, location, deadline, eligibility criteria; for students also their eligibility verdict and application status, for staff the applicant count.",
    roles: ALL_ROLES,
    confirm: false,
    parameters: {
        type: "object",
        properties: { job: { type: "string", description: "Drive id, or company and role, e.g. 'Google SDE'" } },
        required: ["job"],
    },
    handler: async (args, ctx) => {
        const job = await resolveJobRef(ctx.user, args.job, { prefer: ["active", "pending", "draft", "closed"] });
        if (isAmbiguous(job)) return job;
        const view = await viewJobFor(ctx.user, job);
        const deadline = view.applicationDeadline ? ` Apply by ${formatDateTime(view.applicationDeadline)}.` : "";
        let summary = `${view.companyName} – ${view.title}: ${view.packageLabel}, ${view.location || "Location TBA"}.${deadline}`;
        const role = ctx.user.role;
        if (role === "student") {
            if (view.myApplication) summary += ` Your application: ${view.myApplication.statusLabel}.`;
            else if (view.isEligible) summary += " You are eligible.";
            else summary += ` Not eligible: ${view.eligibilityReason || "see the criteria"}`;
        } else if (isStaff(ctx.user) || role === "company") {
            summary += ` ${plural(view.applicantCount, "applicant")}.`;
        }
        const jobId = view._id;
        let ui;
        if (role === "student") ui = { panel: "jobs.detail", params: { jobId, source: "campus" } };
        else if (isStaff(ctx.user) || role === "company") ui = drivesPanel(ctx, { jobId });
        return { summary: clip(summary), data: { job: view }, ...(ui ? { ui } : {}) };
    },
};

const resolveApplyTarget = async (user, args) => {
    const job = await resolveJobRef(user, args.job);
    if (isAmbiguous(job)) return { ambiguous: job };
    const resumeId = args.resumeId ? await resolveResumeRef(user, args.resumeId) : undefined;
    return { job, resumeId };
};

const driveApply = {
    name: "drive_apply",
    description: "Apply the student to a campus drive (in-portal application). Eligibility is checked on the server from the stored profile.",
    roles: ["student"],
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            job: { type: "string", description: "Drive id, or company and role, e.g. 'Infosys systems engineer'" },
            resumeId: { type: "string", description: "Resume id or exact resume title; default: the primary/latest resume" },
            coverNote: { type: "string", maxLength: 2000 },
        },
        required: ["job"],
    },
    preview: async (args, ctx) => {
        const target = await resolveApplyTarget(ctx.user, args);
        if (target.ambiguous) return target.ambiguous;
        const { job, resume } = await checkApply(ctx.user, target.job._id, { resumeId: target.resumeId });
        const closes = target.job.applicationDeadline ? ` Applications close ${formatDateTime(target.job.applicationDeadline)}.` : "";
        const summary = resume
            ? `Apply to ${driveName(job)} (${packageLabel(job)}) with resume "${resume.title}"?${closes}`
            : `Apply to ${driveName(job)} (${packageLabel(job)}) without a resume?${closes}`;
        return {
            summary: clip(summary),
            args: compact({ job: idOf(job._id), resumeId: resume ? idOf(resume.id) : undefined, coverNote: args.coverNote }),
        };
    },
    handler: async (args, ctx) => {
        const target = await resolveApplyTarget(ctx.user, args);
        if (target.ambiguous) return target.ambiguous;
        const { application } = await applyToDrive(ctx.user, target.job._id, {
            resumeId: target.resumeId,
            coverNote: args.coverNote,
            source: "agent",
        });
        return {
            summary: `Applied to ${application.job.companyName} – ${application.job.title}. You can track it under Applications.`,
            data: { application },
            ui: { panel: "applications", params: { applicationId: application._id } },
        };
    },
};

const applicationsList = {
    name: "applications_list",
    description: "List the student's campus drive applications with their pipeline status.",
    roles: ["student"],
    confirm: false,
    parameters: {
        type: "object",
        properties: { status: { type: "string", enum: [...APPLICATION_STATUSES], description: "Only applications in this status" } },
    },
    handler: async (args, ctx) => {
        const applications = await listMyApplications(ctx.user, { status: args.status });
        const shown = applications.slice(0, 50);
        const list = shown.slice(0, 5).map((app) => `${app.job.companyName} – ${app.job.title} (${app.statusLabel})`).join("; ");
        const summary = applications.length === 0
            ? (args.status ? `You have no ${statusLabel(args.status).toLowerCase()} applications.` : "You have no applications yet.")
            : `You have ${plural(applications.length, "application")}: ${list}${applications.length > 5 ? "; …" : ""}.`;
        return { summary: clip(summary), data: { applications: shown }, ui: { panel: "applications", params: compact({ status: args.status }) } };
    },
};

const resolveWithdrawTarget = async (user, args) => {
    if (args.application) return resolveApplicationRef(user, args.application);
    if (args.job) return resolveOwnApplicationByJob(user, args.job);
    return resolveOnlyLiveApplication(user);
};

const applicationWithdraw = {
    name: "application_withdraw",
    description: "Withdraw one of the student's applications (they can re-apply while the drive is open).",
    roles: ["student"],
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            application: { type: "string", description: "Application id, or the drive's company/role" },
            job: { type: "string", description: "The drive's company and role, e.g. 'TCS ninja'" },
        },
    },
    preview: async (args, ctx) => {
        const application = await resolveWithdrawTarget(ctx.user, args);
        if (isAmbiguous(application)) return application;
        checkWithdraw(application);
        const job = application.job || {};
        const reapply = job.applicationDeadline ? ` You can re-apply until ${formatDateTime(job.applicationDeadline)}.` : "";
        return {
            summary: clip(`Withdraw your application to ${driveName(job)} (currently ${statusLabel(application.status)})?${reapply}`),
            args: { application: idOf(application._id) },
        };
    },
    handler: async (args, ctx) => {
        const target = await resolveWithdrawTarget(ctx.user, args);
        if (isAmbiguous(target)) return target;
        const { application } = await withdrawApplication(ctx.user, target._id, {});
        return {
            summary: `Withdrew your application to ${application.job.companyName} – ${application.job.title}.`,
            data: { application },
            ui: { panel: "applications", params: { applicationId: application._id } },
        };
    },
};

// ── Offers ──────────────────────────────────────────────────────────────────

const STAFF_COUNT_ORDER = [["extended", "pending"], ["accepted", "accepted"], ["placed", "placed"], ["rejected", "declined"], ["withdrawn", "withdrawn"], ["expired", "expired"]];

const offersList = {
    name: "offers_list",
    description: "Students: list their placement offers and what each needs. Placement office: offers of the current academic year with counts by status.",
    roles: ["student", "tpo", "admin"],
    confirm: false,
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
        if (ctx.user.role === "student") {
            const offers = await listMyOffers(ctx.user);
            const list = offers.slice(0, 5).map((offer) => `${offer.companyName} ${formatLpa(offer.packageLpa)} LPA (${offerStatusLabel(offer.status)}${offer.status === "extended" ? `, reply by ${formatDay(offer.expiresAt)}` : ""})`).join("; ");
            const summary = offers.length === 0 ? "You have no offers yet." : `You have ${plural(offers.length, "offer")}: ${list}${offers.length > 5 ? "; …" : ""}.`;
            const pending = offers.find((offer) => offer.status === "extended");
            return { summary: clip(summary), data: { offers: offers.slice(0, 20) }, ui: { panel: "offers", params: compact({ offerId: offers.length === 1 ? offers[0]._id : pending?._id }) } };
        }
        const academicYear = academicYearFor(clock.now());
        const { offers, total, statusCounts } = await listOffers(ctx.user, { academicYear, limit: 20 });
        const parts = STAFF_COUNT_ORDER.filter(([status]) => statusCounts[status] > 0).map(([status, word]) => `${statusCounts[status]} ${word}`);
        const summary = total === 0 ? `No offers in ${academicYear} yet.` : `${plural(total, "offer")} in ${academicYear}: ${parts.join(", ")}.`;
        return { summary: clip(summary), data: { offers: offers.slice(0, 20), statusCounts }, ui: { panel: "tpo.offers" } };
    },
};

const resolveOfferTarget = async (user, args) => {
    if (args.offer) return resolveOfferRef(user, args.offer);
    if (args.job) return resolveOfferRef(user, args.job);
    return resolveOnlyPendingOffer(user);
};

const offerRespond = {
    name: "offer_respond",
    description: "Accept or decline one of the student's pending placement offers. Accepting is subject to the one-offer / dream-offer policy.",
    roles: ["student"],
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            offer: { type: "string", description: "Offer id or company name" },
            job: { type: "string", description: "The drive's company/role, if the offer is not named" },
            decision: { type: "string", enum: ["accept", "reject"] },
            reason: { type: "string", maxLength: 500, description: "Optional reason when declining" },
        },
        required: ["decision"],
    },
    preview: async (args, ctx) => {
        const offer = await resolveOfferTarget(ctx.user, args);
        if (isAmbiguous(offer)) return offer;
        if (args.decision === "accept") {
            const check = await checkAccept(ctx.user, offer._id);
            let summary = `Accept the ${offer.companyName} offer (${formatLpa(offer.packageLpa)} LPA, ${offer.roleTitle})?`;
            if (check.upgrade && check.best) summary += ` Your accepted ${check.best.companyName} offer (${formatLpa(check.best.packageLpa)} LPA) will be released.`;
            else if (check.policy.enforceOneOffer) {
                const threshold = round2(offer.packageLpa * check.policy.dreamMultiplier);
                summary += check.policy.allowDreamUpgrade
                    ? ` Under the one-offer policy you will then only be able to apply to drives offering at least ${formatLpa(threshold)} LPA.`
                    : " Under the one-offer policy you will not be able to apply to other drives.";
            }
            return { summary: clip(summary), args: compact({ offer: idOf(offer._id), decision: "accept" }) };
        }
        if (offer.status === "extended" && new Date(offer.expiresAt) <= clock.now()) {
            throw fail(410, "This offer has expired", "OFFER_EXPIRED");
        }
        if (offer.status !== "extended") throw fail(409, `This offer is ${offerStatusLabel(offer.status).toLowerCase()}, not pending`, "OFFER_NOT_PENDING");
        return {
            summary: clip(`Decline the ${offer.companyName} offer (${formatLpa(offer.packageLpa)} LPA)? This cannot be undone.`),
            args: compact({ offer: idOf(offer._id), decision: "reject", reason: args.reason }),
        };
    },
    handler: async (args, ctx) => {
        const offer = await resolveOfferTarget(ctx.user, args);
        if (isAmbiguous(offer)) return offer;
        if (args.decision === "accept") {
            const result = await acceptOffer(ctx.user, offer._id);
            const released = result.released.length ? ` Released: ${result.released.map((entry) => `${entry.companyName} (${formatLpa(entry.packageLpa)} LPA)`).join(", ")}.` : "";
            return {
                summary: clip(`Accepted the ${result.offer.companyName} offer.${released}`),
                data: { offer: result.offer, released: result.released },
                ui: { panel: "offers", params: { offerId: result.offer._id } },
            };
        }
        const result = await rejectOffer(ctx.user, offer._id, { reason: args.reason });
        return {
            summary: `Declined the ${result.offer.companyName} offer.`,
            data: { offer: result.offer },
            ui: { panel: "offers", params: { offerId: result.offer._id } },
        };
    },
};

// ── Training ────────────────────────────────────────────────────────────────

const trainingList = {
    name: "training_list",
    description: "List upcoming training programs (aptitude, technical, mock interviews…), or with mine=true the programs the student registered for.",
    roles: ["student", "tpo", "admin"],
    confirm: false,
    parameters: { type: "object", properties: { mine: { type: "boolean", description: "Students: only my registrations" } } },
    handler: async (args, ctx) => {
        const student = ctx.user.role === "student";
        if (student && args.mine) {
            const enrollments = await listMyEnrollments(ctx.user);
            const list = enrollments.slice(0, 5).map((entry) => `${entry.program.title} (${entry.program.nextSession ? `next ${formatDay(entry.program.nextSession.date)}` : "schedule TBA"})`).join("; ");
            const summary = enrollments.length === 0 ? "You are not registered for any training program." : `You are registered for ${plural(enrollments.length, "program")}: ${list}.`;
            return { summary: clip(summary), data: { enrollments: enrollments.slice(0, 20) }, ui: { panel: "training", params: { tab: "mine" } } };
        }
        const programs = await listPrograms(ctx.user, {});
        const list = programs.slice(0, 5).map((program) => `${program.title} (starts ${program.schedule[0] ? formatDay(program.schedule[0].date) : "TBA"}, ${program.seatsLeft} seats left)`).join("; ");
        const summary = programs.length === 0 ? "No upcoming training programs." : `${plural(programs.length, "upcoming program")}: ${list}.`;
        return {
            summary: clip(summary),
            data: { programs: programs.slice(0, 20) },
            ui: student ? { panel: "training", params: { tab: "discover" } } : { panel: "tpo.training" },
        };
    },
};

const trainingRegister = {
    name: "training_register",
    description: "Register the student for a training program.",
    roles: ["student"],
    confirm: true,
    parameters: {
        type: "object",
        properties: { program: { type: "string", description: "Program id or title, e.g. 'aptitude bootcamp'" } },
        required: ["program"],
    },
    preview: async (args, ctx) => {
        const program = await resolveProgramRef(ctx.user, args.program);
        if (isAmbiguous(program)) return program;
        const { program: checked } = await checkRegistration(ctx.user, program._id);
        const first = [...checked.schedule].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
        const seatsLeft = Math.max(0, checked.capacity - (checked.enrolledCount || 0));
        return {
            summary: clip(`Register for ${checked.title} (starts ${first ? formatDay(first.date) : "TBA"}, ${first?.venue || "TBA"})? ${plural(seatsLeft, "seat")} left.`),
            args: { program: idOf(checked._id) },
        };
    },
    handler: async (args, ctx) => {
        const program = await resolveProgramRef(ctx.user, args.program);
        if (isAmbiguous(program)) return program;
        const { enrollment } = await registerForProgram(ctx.user, program._id);
        return {
            summary: `Registered for ${program.title}.`,
            data: { enrollment },
            ui: { panel: "training", params: { tab: "mine", programId: idOf(program._id) } },
        };
    },
};

// ── Staff and recruiters: drives ────────────────────────────────────────────

const STATUS_WORDS = Object.freeze({ active: "active", pending: "pending approval", draft: "draft", closed: "closed", rejected: "rejected" });

const drivesList = {
    name: "drives_list",
    description: "List campus drives managed by the placement office (or the recruiter's own drives) with counts by status.",
    roles: STAFF_AND_COMPANY,
    confirm: false,
    parameters: {
        type: "object",
        properties: { status: { type: "string", enum: ["draft", "pending", "active", "closed", "rejected", "all"], default: "all" } },
    },
    handler: async (args, ctx) => {
        const status = args.status || "all";
        const { jobs, counts, summaries } = await listDrivesForAgent(ctx.user, { status });
        const total = status === "all" ? Object.values(counts).reduce((sum, value) => sum + value, 0) : jobs.length;
        const parts = Object.entries(STATUS_WORDS).filter(([key]) => counts[key] > 0 && (status === "all" || key === status)).map(([key, word]) => `${counts[key]} ${word}`);
        const pending = jobs.filter((job) => job.status === "pending").slice(0, 3).map(driveName);
        let summary = total === 0 ? "No drives yet." : `${plural(total, "drive")}: ${parts.join(", ")}.`;
        if (pending.length && (status === "all" || status === "pending")) summary += ` Pending: ${pending.join("; ")}.`;
        return { summary: clip(summary), data: { jobs: summaries }, ui: drivesPanel(ctx, { status: status === "all" ? undefined : status }) };
    },
};

const driveBodyFromArgs = (args) => compact({
    companyName: args.company,
    title: args.title,
    description: args.description,
    applicationDeadline: args.deadline,
    salary: args.salary,
    location: args.location,
    employmentType: args.employmentType,
    minimumCgpa: args.minCgpa,
    maximumBacklogs: args.maxBacklogs,
    eligibleBranches: args.branches,
    graduationYears: args.graduationYears,
    skills: args.skills,
});

const driveCreate = {
    name: "drive_create",
    description: "Create a campus drive. Placement office drives are published to eligible students right away; recruiter drives go to the placement office for approval.",
    roles: STAFF_AND_COMPANY,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "Role title, e.g. 'Software Engineer'" },
            company: { type: "string", description: "Company name (recruiters: their own company is used)" },
            description: { type: "string", description: "Job description" },
            deadline: { type: "string", description: "Application deadline, natural language or ISO, e.g. '5 Dec' or 'next friday'" },
            salary: { type: "string", description: "Package, e.g. '18 LPA' or '12-15 LPA'" },
            location: { type: "string" },
            employmentType: { type: "string", description: "e.g. Full-time, Internship" },
            minCgpa: { type: "number", minimum: 0, maximum: 10 },
            maxBacklogs: { type: "integer", minimum: 0, maximum: 50 },
            branches: { type: "array", items: { type: "string" }, description: "Eligible branches, e.g. ['CSE','IT']" },
            graduationYears: { type: "array", items: { type: "string" }, description: "Batches, e.g. ['2026']" },
            skills: { type: "array", items: { type: "string" } },
        },
        required: ["title", "company", "description", "deadline"],
    },
    preview: async (args, ctx) => {
        const user = ctx.user;
        const body = driveBodyFromArgs(args);
        const input = normalizeDriveInput(body, user, { partial: false });
        let companyName = input.companyName;
        if (user.role === "company") {
            const company = user.company ? await Company.findById(user.company).select("name").lean() : null;
            if (!company) throw fail(403, "Your recruiter account is not linked to a company yet. Ask the placement office.", "COMPANY_NOT_LINKED");
            companyName = company.name;
        }
        const set = input.set;
        const label = packageLabel(set);
        const details = [`apply by ${formatDateTime(set.applicationDeadline)}`];
        if (set.minimumCgpa !== undefined) details.push(`min CGPA ${set.minimumCgpa}`);
        if (set.eligibleBranches?.length) details.push(`branches ${set.eligibleBranches.join(", ")}`);
        let summary = `Create ${companyName} – ${set.title} (${label}, ${set.location || "Location TBA"}), ${details.join(", ")}?`;
        if (user.role === "company") summary += " It will be sent to the placement office for approval.";
        else {
            const eligible = await findEligibleStudentIds({ ...set, _id: null, college: user.college ?? null });
            summary += ` It will be published to ${plural(eligible.length, "eligible student")} now.`;
        }
        return { summary: clip(summary), args: compact({ ...args, deadline: toIso(set.applicationDeadline) }) };
    },
    handler: async (args, ctx) => {
        const { job, notifiedStudents } = await createDrive(ctx.user, driveBodyFromArgs(args));
        const name = `${job.companyName} – ${job.title}`;
        const summary = job.status === "pending"
            ? `Submitted ${name} for TPO approval.`
            : `Published ${name}. ${plural(notifiedStudents ?? 0, "eligible student")} notified.`;
        return { summary, data: { job }, ui: drivesPanel(ctx, { jobId: job._id }) };
    },
};

const driveClose = {
    name: "drive_close",
    description: "Close a campus drive for new applications (existing applications are not changed).",
    roles: STAFF_AND_COMPANY,
    confirm: true,
    parameters: {
        type: "object",
        properties: { job: { type: "string", description: "Drive id or company and role" } },
        required: ["job"],
    },
    preview: async (args, ctx) => {
        const job = await resolveJobRef(ctx.user, args.job, { prefer: ["active", "pending", "draft"] });
        if (isAmbiguous(job)) return job;
        if (job.status === "rejected") throw fail(409, "A rejected drive cannot be closed", "INVALID_TRANSITION");
        const [summary] = await buildAgentSummaries(ctx.user, [job]);
        return {
            summary: clip(`Close ${driveName(job)} for new applications? ${plural(summary.applicantCount ?? 0, "applicant")} so far; their applications are not changed.`),
            args: { job: idOf(job._id) },
        };
    },
    handler: async (args, ctx) => {
        const target = await resolveJobRef(ctx.user, args.job, { prefer: ["active", "pending", "draft"] });
        if (isAmbiguous(target)) return target;
        const { job } = await closeDrive(ctx.user, target._id, {});
        return { summary: `Closed ${job.companyName} – ${job.title}.`, data: { job }, ui: drivesPanel(ctx, { jobId: job._id }) };
    },
};

const applicantsList = {
    name: "applicants_list",
    description: "List the applicants of one campus drive, in pipeline order then CGPA, with counts by status.",
    roles: STAFF_AND_COMPANY,
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            job: { type: "string", description: "Drive id or company and role" },
            status: { type: "string", enum: [...APPLICATION_STATUSES] },
        },
        required: ["job"],
    },
    handler: async (args, ctx) => {
        const job = await resolveJobRef(ctx.user, args.job, { prefer: ["active", "closed", "pending", "draft"] });
        if (isAmbiguous(job)) return job;
        const { applications, total, statusCounts } = await listApplicantsForAgent(ctx.user, job._id, { status: args.status });
        const counts = APPLICATION_STATUSES.filter((status) => statusCounts[status] > 0).map((status) => `${statusCounts[status]} ${statusLabel(status).toLowerCase()}`);
        const summary = total === 0
            ? `No ${args.status ? `${statusLabel(args.status).toLowerCase()} ` : ""}applicants for ${driveName(job)} yet.`
            : `${plural(total, "applicant")} for ${driveName(job)}: ${counts.join(", ")}.`;
        const [jobSummary] = await buildAgentSummaries(ctx.user, [job]);
        return {
            summary: clip(summary),
            data: { job: jobSummary, applications, total, statusCounts },
            ui: applicantsPanel(ctx, { jobId: idOf(job._id), status: args.status }),
        };
    },
};

const STAFF_APPLICATION_STATUSES = new Set(["applied", "shortlisted", "interview", "offered", "rejected"]);

const resolveStaffApplication = (user, ref) => resolveApplicationRef(user, ref, {
    statuses: [...STAFF_APPLICATION_STATUSES, "hired", "withdrawn"],
});

const applicationUpdateStatus = {
    name: "application_update_status",
    description: "Move an applicant through the pipeline (applied, shortlisted, interview, rejected). Offers are made with offer_create, not here.",
    roles: STAFF_AND_COMPANY,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            application: { type: "string", description: "Application id, or '<student name/email/roll no> for <company role>'" },
            status: { type: "string", enum: [...STAFF_SETTABLE_STATUSES] },
            note: { type: "string", maxLength: 500, description: "Shown to the student" },
        },
        required: ["application", "status"],
    },
    preview: async (args, ctx) => {
        const application = await resolveStaffApplication(ctx.user, args.application);
        if (isAmbiguous(application)) return application;
        checkStatusChange(application, args.status, ctx.user);
        const student = application.student?.name || "the student";
        const summary = application.status === args.status
            ? `${student} is already ${statusLabel(args.status)} for ${driveName(application.job)}; nothing will change.`
            : `Move ${student} (${driveName(application.job)}) from ${statusLabel(application.status)} to ${statusLabel(args.status)}? The student will be notified.`;
        return { summary: clip(summary), args: compact({ application: idOf(application._id), status: args.status, note: args.note }) };
    },
    handler: async (args, ctx) => {
        const target = await resolveStaffApplication(ctx.user, args.application);
        if (isAmbiguous(target)) return target;
        const { application } = await changeApplicationStatus(ctx.user, target._id, { status: args.status, note: args.note });
        return {
            summary: `${application.student.name} is now ${application.statusLabel} for ${application.job.companyName} – ${application.job.title}.`,
            data: { application },
            ui: applicantsPanel(ctx, { jobId: application.job._id, applicationId: application._id }),
        };
    },
};

const offerBodyFromArgs = (applicationId, args) => compact({
    applicationId,
    ctc: args.ctc,
    roleTitle: args.role,
    joiningDate: args.joiningDate,
    expiresAt: args.expiresAt,
});

const offerCreate = {
    name: "offer_create",
    description: "Extend a placement offer to an applicant (their application moves to 'Offer received' and they are notified).",
    roles: STAFF_AND_COMPANY,
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            application: { type: "string", description: "Application id, or '<student> for <company role>'" },
            ctc: { type: ["number", "string"], description: "Package in LPA (e.g. 12) or text (e.g. '12 LPA', '₹12,00,000')" },
            role: { type: "string", description: "Role title; default: the drive's title" },
            joiningDate: { type: "string", description: "Expected joining date" },
            expiresAt: { type: "string", description: "Response deadline; default: the policy's offer expiry" },
        },
        required: ["application", "ctc"],
    },
    preview: async (args, ctx) => {
        const application = await resolveApplicationRef(ctx.user, args.application, { statuses: ["applied", "shortlisted", "interview"] });
        if (isAmbiguous(application)) return application;
        const prepared = await prepareOffer(ctx.user, offerBodyFromArgs(idOf(application._id), args));
        const fields = prepared.fields;
        return {
            summary: clip(`Extend an offer to ${prepared.student.name} for ${fields.companyName} – ${fields.roleTitle} at ${formatLpa(fields.packageLpa)} LPA (${fields.offerType} offer), expiring ${formatDateTime(fields.expiresAt)}?`),
            args: compact({
                application: idOf(application._id),
                ctc: fields.packageLpa,
                role: args.role,
                joiningDate: fields.joiningDate ? toIso(fields.joiningDate) : undefined,
                expiresAt: toIso(fields.expiresAt),
            }),
        };
    },
    handler: async (args, ctx) => {
        const target = await resolveApplicationRef(ctx.user, args.application, { statuses: ["applied", "shortlisted", "interview"] });
        if (isAmbiguous(target)) return target;
        const { offer } = await createOffer(ctx.user, offerBodyFromArgs(idOf(target._id), args));
        const ui = isCompany(ctx)
            ? { panel: "company.applicants", params: compact({ jobId: offer.job?._id, applicationId: offer.application }) }
            : { panel: "tpo.offers", params: { offerId: offer._id } };
        return {
            summary: `Offer extended to ${offer.student.name} (${formatLpa(offer.packageLpa)} LPA). They have until ${formatDateTime(offer.expiresAt)} to respond.`,
            data: { offer },
            ui,
        };
    },
};

const placementStats = {
    name: "placement_stats",
    description: "Placement statistics for the current academic year: placed %, packages, offers awaiting a response and top recruiters.",
    roles: ["tpo", "admin"],
    confirm: false,
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
        const stats = await computeStats(ctx.user, {});
        const { totals, packages, offersByStatus, topCompanies, academicYear } = stats;
        let summary = `${academicYear}: ${totals.placedPercent ?? 0}% placed (${totals.placedStudents}/${totals.students}).`;
        if (packages.count > 0) {
            summary += ` Average ${formatLpa(packages.avgLpa)} LPA, median ${formatLpa(packages.medianLpa)} LPA, highest ${formatLpa(packages.maxLpa)} LPA.`;
        }
        summary += ` ${plural(offersByStatus.extended, "offer")} awaiting a response.`;
        const recruiters = topCompanies.filter((company) => company.accepted > 0).slice(0, 3);
        if (recruiters.length) summary += ` Top recruiters: ${recruiters.map((company) => `${company.companyName} (${company.accepted})`).join(", ")}.`;
        return { summary: clip(summary), data: { stats }, ui: { panel: "tpo.analytics", params: { academicYear } } };
    },
};

const announce = {
    name: "announce",
    description: "Send a placement announcement (in-app notification, optional email) to students or other roles of the college, optionally narrowed by branch and passing year.",
    roles: ["tpo", "admin"],
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", maxLength: 140 },
            body: { type: "string", maxLength: 1000 },
            audience: {
                type: "object",
                properties: {
                    roles: { type: "array", items: { type: "string", enum: ["student", "teacher", "alumni", "company", "tpo"] } },
                    branch: { type: "string", description: "e.g. CSE" },
                    passingYear: { type: "string", description: "e.g. 2027" },
                },
            },
        },
        required: ["title", "body", "audience"],
    },
    preview: async (args, ctx) => {
        const message = normalizeAnnouncement(args);
        const { recipients, audience } = await resolveAnnouncementAudience(ctx.user, args.audience);
        const filters = [...audience.branch, ...audience.passingYear];
        const roles = audience.roles.map((role) => (role === "company" ? "recruiters" : `${role}s`)).join(" and ");
        return {
            summary: clip(`Send "${message.title}" to ${recipients.length} ${roles}${filters.length ? ` (${filters.join(", ")})` : ""}?`),
            args,
        };
    },
    handler: async (args, ctx) => {
        const { recipients } = await sendAnnouncement(ctx.user, { title: args.title, body: args.body, audience: args.audience });
        return { summary: `Announcement sent to ${plural(recipients, "user")}.`, data: { recipients } };
    },
};

const driveReview = {
    name: "drive_review",
    description: "Approve (publish to eligible students) or reject a recruiter-submitted campus drive that is awaiting approval.",
    roles: ["tpo", "admin"],
    confirm: true,
    parameters: {
        type: "object",
        properties: {
            job: { type: "string", description: "Drive id or company and role" },
            decision: { type: "string", enum: ["approve", "reject"] },
            note: { type: "string", maxLength: 500, description: "Required when rejecting; the recruiter sees it" },
        },
        required: ["job", "decision"],
    },
    preview: async (args, ctx) => {
        const job = await resolveJobRef(ctx.user, args.job, { prefer: ["pending", "draft", "rejected"] });
        if (isAmbiguous(job)) return job;
        if (args.decision === "approve") {
            if (job.status === "active") throw fail(409, "This drive is already published", "INVALID_TRANSITION");
            if (job.applicationDeadline && new Date(job.applicationDeadline) <= clock.now()) {
                throw fail(409, "The application deadline has passed; move it to a future date before publishing", "DEADLINE_PASSED");
            }
            const eligible = job.notifiedAt ? [] : await findEligibleStudentIds(job);
            return {
                summary: clip(`Approve ${driveName(job)} and notify ${plural(eligible.length, "eligible student")}?`),
                args: compact({ job: idOf(job._id), decision: "approve", note: args.note }),
            };
        }
        if (job.status !== "pending") throw fail(409, "Only drives awaiting approval can be rejected", "INVALID_TRANSITION");
        const note = String(args.note ?? "").trim();
        if (note.length < 3) throw fail(400, "Add a note (3–500 characters) for the recruiter", "VALIDATION", { field: "note" });
        return { summary: clip(`Reject ${driveName(job)}? The recruiter will see your note.`), args: { job: idOf(job._id), decision: "reject", note } };
    },
    handler: async (args, ctx) => {
        const target = await resolveJobRef(ctx.user, args.job, { prefer: ["pending", "draft", "rejected"] });
        if (isAmbiguous(target)) return target;
        if (args.decision === "approve") {
            const { job, notifiedStudents } = await publishDrive(ctx.user, target._id, { note: args.note });
            return {
                summary: `Approved ${job.companyName} – ${job.title}; ${plural(notifiedStudents ?? 0, "student")} notified.`,
                data: { job },
                ui: { panel: "tpo.drives", params: { jobId: job._id } },
            };
        }
        const { job } = await rejectDrive(ctx.user, target._id, { note: args.note });
        return { summary: `Rejected ${job.companyName} – ${job.title}.`, data: { job }, ui: { panel: "tpo.drives", params: { jobId: job._id } } };
    },
};

export default [
    jobsSearchCampus,
    jobDetails,
    driveApply,
    applicationsList,
    applicationWithdraw,
    offersList,
    offerRespond,
    trainingList,
    trainingRegister,
    drivesList,
    driveCreate,
    driveClose,
    applicantsList,
    applicationUpdateStatus,
    offerCreate,
    placementStats,
    announce,
    driveReview,
];

