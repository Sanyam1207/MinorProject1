// ALL notify() and socket calls of the placements module (docs/contracts/PLACEMENTS.md §9, §10).
// Tests replace the notifier with setNotifier(fn) and await background fan-outs with flushEvents().
import { Job } from "../../../models/job.models.js";
import { User } from "../../../models/user.models.js";
import { emitToUser, emitToUsers } from "../../../core/realtime.js";
import { notify as defaultNotify } from "../../notifications/notify.js";
import { APPLICATION_STATUS_BODIES, offerStatusLabel, statusLabel } from "../constants.js";
import { clock, formatDateTime, formatDay } from "../utils/dates.js";
import { findEligibleStudentIds } from "./eligibility.service.js";
import { formatLpa, packageLabel } from "./package.js";
import { companyOf, idOf } from "./views.js";

const FANOUT_BATCH = 500;
const TITLE_MAX = 140;

let notifier = defaultNotify;
const pending = new Set();

/** Replace notify() (tests). Pass null to restore the real one. */
export const setNotifier = (fn) => {
    notifier = typeof fn === "function" ? fn : defaultNotify;
};

/** Resolve once every background fan-out started so far has finished. */
export const flushEvents = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
};

const log = (message, error) => {
    if (process.env.NODE_ENV !== "test") console.error(`[placements] ${message}:`, error?.message || error);
};

const title = (text) => {
    const value = String(text ?? "").trim();
    return value.length > TITLE_MAX ? `${value.slice(0, TITLE_MAX - 1)}…` : value;
};

const uniqueIds = (ids) => [...new Set((ids || []).filter(Boolean).map((id) => idOf(id)))];

/** notify() that never throws (notification failures must not fail the action). */
const send = async (userIds, payload) => {
    const ids = uniqueIds(userIds);
    if (ids.length === 0) return { created: 0 };
    try {
        return (await notifier(ids, { ...payload, title: title(payload.title) })) || { created: 0 };
    } catch (error) {
        log(`notification ${payload.type} failed`, error);
        return { created: 0 };
    }
};

/** Run `task` after the current request (setImmediate); errors are logged. */
export const inBackground = (task) => {
    const promise = new Promise((resolve) => setImmediate(resolve))
        .then(task)
        .catch((error) => log("background task failed", error));
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
};

const sendInBatches = async (ids, payload) => {
    for (let start = 0; start < ids.length; start += FANOUT_BATCH) {
        await send(ids.slice(start, start + FANOUT_BATCH), payload);
    }
};

// ── Recipients ──────────────────────────────────────────────────────────────

/** TPOs of a college (falling back to admins when there are none). */
export const tpoIdsFor = async (collegeId) => {
    const college = collegeId ? idOf(collegeId) : null;
    if (college) {
        const tpos = await User.find({ role: "tpo", college, isActive: { $ne: false } }).select("_id").lean();
        if (tpos.length > 0) return tpos.map((user) => String(user._id));
    }
    const admins = await User.find({ role: "admin", isActive: { $ne: false } }).select("_id").lean();
    return admins.map((user) => String(user._id));
};

/** Recruiters of a company within a college scope. */
export const recruiterIdsFor = async (companyId, collegeId) => {
    if (!companyId) return [];
    const filter = { role: "company", company: idOf(companyId), isActive: { $ne: false } };
    if (collegeId) filter.college = { $in: [idOf(collegeId), null] };
    const recruiters = await User.find(filter).select("_id").lean();
    return recruiters.map((user) => String(user._id));
};

const staffAudience = async (collegeId, companyId) => {
    const [tpos, recruiters] = await Promise.all([tpoIdsFor(collegeId), recruiterIdsFor(companyId, collegeId)]);
    return { tpos, recruiters, all: uniqueIds([...tpos, ...recruiters]) };
};

const emitSafely = (fn) => {
    try {
        fn();
    } catch (error) {
        log("socket emit failed", error);
    }
};

const emitToStaff = async (collegeId, companyId, event, payload) => {
    try {
        const { all } = await staffAudience(collegeId, companyId);
        emitSafely(() => emitToUsers(all, event, payload));
    } catch (error) {
        log(`socket ${event} failed`, error);
    }
};

const jobCompanyName = (job) => companyOf(job).name;
const companyIdOf = (job) => idOf(job?.company?._id ?? job?.company);

// ── Drives ──────────────────────────────────────────────────────────────────

/** `placement:job` to the drive's TPOs and recruiters. */
export const jobChanged = (job, action) => inBackground(() => emitToStaff(
    job.college?._id ?? job.college,
    companyIdOf(job),
    "placement:job",
    { jobId: idOf(job._id), status: job.status || "active", action },
));

const loadJobForEvents = async (job) => {
    if (job?.company && typeof job.company === "object" && job.company.name !== undefined) return job;
    return Job.findById(job._id).populate("company", "name").lean();
};

/**
 * The drive.new fan-out (§7.1). Claims `notifiedAt` atomically, so a drive is announced at most once.
 * @param {object} job
 * @param {{background?: boolean}} [options] background: compute recipients in the background too (AI creator)
 * @returns {Promise<number|null>} recipients queued (0 when already announced)
 */
export const drivePublished = async (job, { background = false } = {}) => {
    const run = async () => {
        const claim = await Job.updateOne({ _id: job._id, notifiedAt: null }, { $set: { notifiedAt: clock.now() } });
        if (claim.modifiedCount !== 1) return 0;
        const full = await loadJobForEvents(job);
        if (!full) return 0;
        const recipients = await findEligibleStudentIds(full);
        if (recipients.length > 0) {
            const company = jobCompanyName(full);
            const payload = {
                type: "placement.drive.new",
                title: `New drive: ${company} – ${full.title}`,
                body: `${packageLabel(full)} · ${full.location || "Location TBA"} · Apply by ${formatDay(full.applicationDeadline) || "TBA"}`,
                ui: { panel: "jobs.detail", params: { jobId: idOf(full._id), source: "campus" } },
                data: { jobId: idOf(full._id) },
                priority: "normal",
                email: true,
                dedupeKey: `drive-new:${idOf(full._id)}`,
            };
            inBackground(() => sendInBatches(recipients, payload));
        }
        return recipients.length;
    };
    if (background) {
        inBackground(run);
        return null;
    }
    return run();
};

/** A company created a drive, or resubmitted a rejected one → the college's TPOs. */
export const driveSubmitted = (job, { recruiterName } = {}) => inBackground(async () => {
    const full = await loadJobForEvents(job);
    if (!full) return;
    const jobId = idOf(full._id);
    await send(await tpoIdsFor(full.college), {
        type: "placement.drive.pending",
        title: `Drive awaiting approval: ${jobCompanyName(full)} – ${full.title}`,
        body: `Submitted by ${recruiterName || "a recruiter"}.`,
        ui: { panel: "tpo.drives", params: { jobId, status: "pending" } },
        data: { jobId },
        priority: "high",
        email: true,
        dedupeKey: `drive-pending:${jobId}:${new Date(full.updatedAt || clock.now()).getTime()}`,
    });
});

/** A TPO approved, rejected or closed a company drive → the company's recruiters. */
export const driveStatusToRecruiters = (job, decision, note = "") => inBackground(async () => {
    if (job.createdByRole !== "company") return;
    const full = await loadJobForEvents(job);
    if (!full) return;
    const jobId = idOf(full._id);
    await send(await recruiterIdsFor(companyIdOf(full), full.college), {
        type: "placement.drive.status",
        title: `Drive ${decision}: ${full.title}`,
        body: note || (decision === "approved" ? "Your drive is now open to eligible students." : ""),
        ui: { panel: "company.drives", params: { jobId } },
        data: { jobId, decision },
        priority: "normal",
        email: true,
    });
});

/** Last-chance reminder to eligible students who have not applied (sweep). */
export const deadlineReminder = async (job, recipients) => {
    if (!recipients.length) return 0;
    const jobId = idOf(job._id);
    await sendInBatches(recipients, {
        type: "placement.drive.deadline",
        title: `Last chance: ${jobCompanyName(job)} – ${job.title}`,
        body: `Applications close ${formatDateTime(job.applicationDeadline)}.`,
        ui: { panel: "jobs.detail", params: { jobId, source: "campus" } },
        data: { jobId },
        priority: "normal",
        dedupeKey: `drive-deadline:${jobId}`,
    });
    return recipients.length;
};

// ── Applications ────────────────────────────────────────────────────────────

const applicantsPayload = (application, action) => ({
    applicationId: idOf(application._id),
    jobId: idOf(application.job?._id ?? application.job),
    status: application.status,
    action,
});

/**
 * Socket events for any application change.
 * @param {object} application  (job populated or not)
 * @param {object} studentView  ApplicationStudentView
 */
export const applicationChanged = (application, studentView, action = "updated") => {
    emitSafely(() => emitToUser(idOf(application.student?._id ?? application.student), "placement:application", { application: studentView }));
    inBackground(() => emitToStaff(application.college, application.company, "placement:applicants", applicantsPayload(application, action)));
};

/** A student applied or re-applied → the drive company's recruiters (not TPOs). */
export const applicationCreated = (application, job, student) => inBackground(async () => {
    const recruiters = await recruiterIdsFor(application.company, application.college);
    const applicationId = idOf(application._id);
    const jobId = idOf(job._id);
    const branch = student.branch || "Branch not set";
    const cgpa = student.cgpa ?? "—";
    await send(recruiters, {
        type: "placement.application.new",
        title: `New applicant: ${student.name} – ${job.title}`,
        body: `${branch} · CGPA ${cgpa}`,
        ui: { panel: "company.applicants", params: { jobId, applicationId } },
        data: { jobId, applicationId },
        priority: "low",
        dedupeKey: `app-new:${applicationId}:${(application.timeline || []).length}`,
    });
});

/** placement.application.status to the student (staff change, staff add or offer sync). */
export const applicationStatusToStudent = (application, job, { title: customTitle, note } = {}) => {
    const status = application.status;
    const applicationId = idOf(application._id);
    return send([application.student?._id ?? application.student], {
        type: "placement.application.status",
        title: customTitle || `${jobCompanyName(job)} – ${job.title}: ${statusLabel(status)}`,
        body: note || APPLICATION_STATUS_BODIES[status] || "",
        ui: { panel: "applications", params: { applicationId } },
        data: { applicationId, jobId: idOf(job._id), status },
        priority: ["shortlisted", "interview", "hired"].includes(status) ? "high" : "normal",
        email: ["shortlisted", "interview"].includes(status),
        dedupeKey: `app-status:${applicationId}:${(application.timeline || []).length}`,
    });
};

// ── Offers ──────────────────────────────────────────────────────────────────

/** Socket events for any offer change. */
export const offerChanged = (offer, studentView, action) => {
    emitSafely(() => emitToUser(idOf(offer.student?._id ?? offer.student), "placement:offer", { offer: studentView }));
    inBackground(() => emitToStaff(offer.college, offer.company, "placement:offers", { offerId: idOf(offer._id), status: offer.status, action }));
};

export const offerCreated = (offer) => {
    const offerId = idOf(offer._id);
    return send([offer.student?._id ?? offer.student], {
        type: "placement.offer.new",
        title: `Offer from ${offer.companyName}: ${formatLpa(offer.packageLpa)} LPA`,
        body: `${offer.roleTitle}. Respond by ${formatDateTime(offer.expiresAt)}.`,
        ui: { panel: "offers", params: { offerId } },
        data: { offerId },
        priority: "high",
        email: true,
        dedupeKey: `offer-new:${offerId}`,
    });
};

/** placement.offer.updated to the student (place, override, revoke, PATCH, expire). */
export const offerUpdatedToStudent = (offer, { note = "", edited = false } = {}) => {
    const offerId = idOf(offer._id);
    return send([offer.student?._id ?? offer.student], {
        type: "placement.offer.updated",
        title: edited ? `Your ${offer.companyName} offer was updated` : `Your ${offer.companyName} offer: ${offerStatusLabel(offer.status)}`,
        body: note,
        ui: { panel: "offers", params: { offerId } },
        data: { offerId, status: offer.status },
        priority: "high",
        dedupeKey: `offer-upd:${offerId}:${(offer.statusHistory || []).length}`,
    });
};

const RESPONSE_VERBS = Object.freeze({
    accepted: "accepted",
    rejected: "declined",
    withdrawn: "withdrew from",
    expired: "let expire",
});

/** placement.offer.updated to staff (student response, upgrade release, expiry). */
export const offerResponseToStaff = (offer, { studentName, reason = "" } = {}) => inBackground(async () => {
    const offerId = idOf(offer._id);
    const verb = RESPONSE_VERBS[offer.status] || offer.status;
    const base = {
        type: "placement.offer.updated",
        title: `${studentName || "A student"} ${verb} the ${offer.companyName} offer`,
        body: `${formatLpa(offer.packageLpa)} LPA · ${offer.roleTitle}${reason ? ` — ${reason}` : ""}`,
        data: { offerId, status: offer.status },
        priority: "normal",
        dedupeKey: `offer-resp:${offerId}:${(offer.statusHistory || []).length}`,
    };
    const { tpos, recruiters } = await staffAudience(offer.college, offer.company);
    await send(tpos, { ...base, ui: { panel: "tpo.offers", params: { offerId } } });
    const recruiterOnly = recruiters.filter((id) => !tpos.includes(id));
    if (recruiterOnly.length > 0) {
        const params = {};
        if (offer.job) params.jobId = idOf(offer.job);
        if (offer.application) params.applicationId = idOf(offer.application);
        await send(recruiterOnly, { ...base, ui: { panel: "company.applicants", params } });
    }
});

export const offerExpiring = (offer) => {
    const offerId = idOf(offer._id);
    return send([offer.student?._id ?? offer.student], {
        type: "placement.offer.expiring",
        title: `Your ${offer.companyName} offer expires ${formatDateTime(offer.expiresAt)}`,
        body: "Accept or decline it before it expires.",
        ui: { panel: "offers", params: { offerId } },
        data: { offerId },
        priority: "high",
        email: true,
        dedupeKey: `offer-expiring:${offerId}`,
    });
};

// ── Training ────────────────────────────────────────────────────────────────

export const trainingCreated = (program, recipients) => inBackground(async () => {
    const programId = idOf(program._id);
    const first = program.schedule?.[0];
    await sendInBatches(recipients, {
        type: "training.new",
        title: `New training: ${program.title}`,
        body: `${program.type || "other"} · starts ${formatDay(first?.date) || "TBA"} · ${first?.venue || "TBA"}`,
        ui: { panel: "training", params: { programId } },
        data: { programId },
        priority: "normal",
        dedupeKey: `training-new:${programId}`,
    });
});

/** Schedule/venue change or cancel → registered students (+ placement:training socket). */
export const trainingUpdated = (program, recipients, { cancelled = false, summary = "" } = {}) => {
    const programId = idOf(program._id);
    emitSafely(() => emitToUsers(uniqueIds(recipients), "placement:training", { programId, action: cancelled ? "cancelled" : "updated" }));
    return inBackground(() => sendInBatches(recipients, {
        type: "training.updated",
        title: cancelled ? `Training cancelled: ${program.title}` : `Training updated: ${program.title}`,
        body: summary,
        ui: { panel: "training", params: { programId, tab: "mine" } },
        data: { programId, cancelled },
        priority: cancelled ? "high" : "normal",
    }));
};

// ── Announcements ───────────────────────────────────────────────────────────

export const announcement = (recipients, { title: heading, body, email = true }) => inBackground(() => sendInBatches(recipients, {
    type: "placement.announcement",
    title: heading,
    body,
    priority: "normal",
    email: Boolean(email),
}));
