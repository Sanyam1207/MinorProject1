// Offer lifecycle and placement-policy enforcement (docs/contracts/PLACEMENTS.md §6.3, §7.3).
// Every transition is a status-guarded update; a lost race answers 409.
import mongoose from "mongoose";
import { assertObjectId, escapeRegex, fail, intParam, isObjectId } from "../../../core/http.js";
import { Job } from "../../../models/job.models.js";
import { User } from "../../../models/user.models.js";
import {
    HELD_OFFER_STATUSES,
    LIVE_APPLICATION_STATUSES,
    LIVE_OFFER_STATUSES,
    OFFER_STATUSES,
    isStaff,
    offerStatusLabel,
} from "../constants.js";
import { Application } from "../models/application.model.js";
import { Offer } from "../models/offer.model.js";
import { addDays, clock, endOfDay, parseDateInput, startOfDay } from "../utils/dates.js";
import { enumList, httpsUrl, oneOf, str } from "../utils/input.js";
import { academicYearFor, isValidAcademicYear } from "./academic-year.js";
import { syncFromOffer } from "./application.service.js";
import * as events from "./events.js";
import { withLock } from "./locks.js";
import { formatLpa, parsePackageLpa, round2 } from "./package.js";
import { classifyOffer, createPolicyCache, resolvePolicy } from "./policy.service.js";
import { andFilters, collegeScope, notFound, offerScope, resolveJobScope, applicationScope } from "./scope.js";
import { emptyOfferCounts, idOf, toOfferStaffView, toOfferStudentView } from "./views.js";

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));
const invalid = (field, message) => fail(400, message, "VALIDATION", { field });

const STAFF_OFFER_POPULATE = [
    { path: "student", select: "name email branch cgpa rollNumber passingYear" },
    { path: "createdBy", select: "name role" },
    { path: "job", select: "title" },
];
const STUDENT_OFFER_POPULATE = [{ path: "job", select: "title" }];

const roleOf = (user) => user?.role || "system";
const historyEntry = (status, user, note = "") => ({
    status,
    changedAt: clock.now(),
    by: user?._id ?? null,
    byRole: user ? roleOf(user) : "system",
    byName: user?.name || (user ? "" : "System"),
    note: String(note || "").slice(0, 600),
});

// ── Computed fields and views ───────────────────────────────────────────────

/**
 * `Map<offerId, {currentAcceptedPackage, dreamMultiplier, isDreamEligible}>` (§5 OfferStudentView).
 */
export const computeOfferExtras = async (offers) => {
    const extras = new Map();
    if (offers.length === 0) return extras;
    const studentIds = [...new Set(offers.map((offer) => idOf(offer.student?._id ?? offer.student)))];
    const held = await Offer.find({ student: { $in: studentIds }, status: { $in: HELD_OFFER_STATUSES } })
        .select("student packageLpa").lean();
    const policyFor = createPolicyCache();
    for (const offer of offers) {
        const studentId = idOf(offer.student?._id ?? offer.student);
        const others = held.filter((entry) => String(entry.student) === studentId && String(entry._id) !== String(offer._id));
        const current = others.length ? Math.max(...others.map((entry) => entry.packageLpa)) : null;
        const policy = await policyFor(offer.college ?? null, offer.academicYear);
        const isDreamEligible = offer.status === "extended" && current !== null && Boolean(policy.allowDreamUpgrade)
            && offer.packageLpa >= round2(current * policy.dreamMultiplier);
        extras.set(String(offer._id), { currentAcceptedPackage: current, dreamMultiplier: policy.dreamMultiplier, isDreamEligible });
    }
    return extras;
};

const studentViews = async (offers) => {
    const extras = await computeOfferExtras(offers);
    return offers.map((offer) => toOfferStudentView(offer, extras.get(String(offer._id))));
};

const staffViews = async (offers, viewer) => {
    const extras = await computeOfferExtras(offers);
    return offers.map((offer) => toOfferStaffView(offer, extras.get(String(offer._id)), { viewer }));
};

const studentView = async (offerId) => {
    const offer = await Offer.findById(offerId).populate(STUDENT_OFFER_POPULATE).lean();
    return (await studentViews([offer]))[0];
};

const staffView = async (offerId, viewer) => {
    const offer = await Offer.findById(offerId).populate(STAFF_OFFER_POPULATE).lean();
    return (await staffViews([offer], viewer))[0];
};

/** The view matching the caller. */
export const viewOfferFor = async (user, offerId) => (user.role === "student" ? studentView(offerId) : staffView(offerId, user));

/** Socket events after every offer change. */
const emitOffer = async (offer, action) => {
    try {
        events.offerChanged(offer, await studentView(offer._id), action);
    } catch (error) {
        if (process.env.NODE_ENV !== "test") console.error("[placements] offer socket emit failed:", error?.message || error);
    }
};

const studentNameOf = async (offer) => {
    if (offer.student && typeof offer.student === "object" && offer.student.name) return offer.student.name;
    const student = await User.findById(offer.student?._id ?? offer.student).select("name").lean();
    return student?.name || "A student";
};

// ── Expiry ──────────────────────────────────────────────────────────────────

/**
 * extended → expired (sweep, or lazily on read/accept/reject). Returns the updated offer or null.
 */
export const expireOffer = async (offer) => {
    const now = clock.now();
    const updated = await Offer.findOneAndUpdate(
        { _id: offer._id, status: "extended", expiresAt: { $lte: now } },
        { $set: { status: "expired" }, $push: { statusHistory: historyEntry("expired", null, "Expired without a response") } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) return null;
    await syncFromOffer(updated, { notify: false });
    await events.offerUpdatedToStudent(updated, { note: "The offer expired without a response." });
    events.offerResponseToStaff(updated, { studentName: await studentNameOf(updated) });
    await emitOffer(updated, "expired");
    return updated;
};

/** Expire every due offer of one student (GET /offers/my, accept, reject). */
export const expireDueOffersForStudent = async (studentId) => {
    const due = await Offer.find({ student: studentId, status: "extended", expiresAt: { $lte: clock.now() } }).lean();
    for (const offer of due) await expireOffer(offer);
    return due.length;
};

// ── Create ──────────────────────────────────────────────────────────────────

const resolvePackage = (body) => {
    if (body.packageLpa !== undefined && body.packageLpa !== null && body.packageLpa !== "") {
        const value = typeof body.packageLpa === "number" ? body.packageLpa : parsePackageLpa(String(body.packageLpa)).min;
        if (!Number.isFinite(value) || value <= 0 || value > 500) throw invalid("packageLpa", "packageLpa must be greater than 0 and at most 500 (LPA)");
        return { packageLpa: round2(value), ctcText: typeof body.packageLpa === "string" ? body.packageLpa.trim().slice(0, 100) : undefined };
    }
    if (body.ctc !== undefined && body.ctc !== null && body.ctc !== "") {
        const parsed = parsePackageLpa(typeof body.ctc === "number" ? body.ctc : String(body.ctc));
        if (parsed.min === null) throw invalid("ctc", "ctc could not be read as a package; use LPA, e.g. 12 or \"12 LPA\"");
        return { packageLpa: parsed.min, ctcText: typeof body.ctc === "string" ? body.ctc.trim().slice(0, 100) : undefined };
    }
    throw invalid("packageLpa", "packageLpa (or ctc) is required");
};

const resolveExpiry = (value, policy, field = "expiresAt") => {
    if (value === undefined || value === null || value === "") {
        return endOfDay(addDays(clock.now(), policy.offerExpiryDays));
    }
    const expiresAt = parseDateInput(value, { endOfDay: true, field });
    if (expiresAt.getTime() <= clock.now().getTime()) throw invalid(field, `${field} must be in the future`);
    return expiresAt;
};

const optionalDay = (value, field) => (value === undefined || value === null || value === ""
    ? undefined
    : startOfDay(parseDateInput(value, { field })));

const bestHeldPackage = async (studentId, excludeId = null) => {
    const filter = { student: studentId, status: { $in: HELD_OFFER_STATUSES } };
    if (excludeId) filter._id = { $ne: excludeId };
    const best = await Offer.findOne(filter).sort({ packageLpa: -1 }).select("packageLpa companyName").lean();
    return best ? best : null;
};

/**
 * Every read-only check for creating an offer (also the offer_create preview).
 * @returns {Promise<object>} the fields of the offer to create plus context
 */
export const prepareOffer = async (user, body = {}) => {
    if (!isStaff(user) && user.role !== "company") throw fail(403, "Only the placement office and recruiters can extend offers", "FORBIDDEN");
    const pkg = resolvePackage(body);
    const roleTitleInput = str(body.roleTitle, { field: "roleTitle", max: 200 });
    const location = str(body.location, { field: "location", max: 200 });
    const offerLetterUrl = httpsUrl(body.offerLetterUrl, { field: "offerLetterUrl" });
    const joiningDate = optionalDay(body.joiningDate, "joiningDate");
    const note = str(body.note, { field: "note", max: 500 }) ?? "";

    let application = null;
    let job = null;
    let student = null;
    let companyName;
    let roleTitle = roleTitleInput;

    const hasApplication = body.applicationId !== undefined && body.applicationId !== null && body.applicationId !== "";
    if (hasApplication) {
        assertObjectId(String(body.applicationId), "applicationId");
        application = await Application.findOne(andFilters({ _id: toObjectId(body.applicationId) }, applicationScope(user))).lean();
        if (!application) throw notFound("Application");
        job = await Job.findById(application.job).populate("company", "name").lean();
        student = await User.findById(application.student).lean();
        if (!job || !student) throw notFound("Application");
    } else {
        if (user.role === "company") throw invalid("applicationId", "applicationId is required");
        assertObjectId(String(body.studentId ?? ""), "studentId");
        student = await User.findOne(andFilters({ _id: toObjectId(body.studentId), role: "student" }, collegeScope(user))).lean();
        if (!student) throw notFound("Student");
        if (body.jobId !== undefined && body.jobId !== null && body.jobId !== "") {
            assertObjectId(String(body.jobId), "jobId");
            job = await Job.findOne(andFilters({ _id: toObjectId(body.jobId) }, await resolveJobScope(user))).populate("company", "name").lean();
            if (!job) throw notFound("Drive");
            application = await Application.findOne({ job: job._id, student: student._id }).lean();
            if (application && !LIVE_APPLICATION_STATUSES.includes(application.status)) application = null;
        } else {
            companyName = str(body.companyName, { field: "companyName", max: 200, required: true });
            roleTitle = str(body.roleTitle, { field: "roleTitle", max: 200, required: true });
        }
    }

    if (application) {
        if (!LIVE_APPLICATION_STATUSES.includes(application.status)) {
            throw fail(409, "Offers can be extended only to applications that are applied, shortlisted or in interview", "INVALID_TRANSITION");
        }
        const live = await Offer.findOne({ application: application._id, status: { $in: LIVE_OFFER_STATUSES } }).select("_id status").lean();
        if (live) throw fail(409, "This application already has a live offer", "OFFER_EXISTS", { offerId: idOf(live._id) });
    }
    if (job) {
        companyName = job.company?.name || "Unknown Company";
        roleTitle = roleTitle || job.title;
    }

    const college = application?.college ?? job?.college ?? student.college ?? null;
    const academicYear = academicYearFor(clock.now());
    const policy = await resolvePolicy(college, academicYear);
    const pending = await Offer.countDocuments({ student: student._id, status: "extended" });
    if (pending >= policy.maxPendingOffers) {
        throw fail(409, `${student.name} already holds ${pending} pending offer(s); the policy allows ${policy.maxPendingOffers}`, "MAX_PENDING_OFFERS");
    }
    const expiresAt = resolveExpiry(body.expiresAt, policy);
    const best = await bestHeldPackage(student._id);
    const offerType = classifyOffer(pkg.packageLpa, best?.packageLpa ?? null, policy);

    return {
        student,
        application,
        job,
        policy,
        note,
        fields: {
            student: student._id,
            application: application?._id ?? null,
            job: job?._id ?? null,
            company: job?.company?._id ?? job?.company ?? null,
            college,
            companyName,
            roleTitle,
            packageLpa: pkg.packageLpa,
            ctcText: pkg.ctcText,
            offerType,
            status: "extended",
            expiresAt,
            joiningDate: joiningDate ?? null,
            location: location ?? "",
            offerLetterUrl,
            academicYear,
            createdBy: user._id,
            createdByRole: user.role,
        },
    };
};

/** POST /offers → {offer: OfferStaffView} */
export const createOffer = async (user, body = {}) => {
    const preview = await prepareOffer(user, body);
    return withLock(`offers:${preview.student._id}`, async () => {
        const prepared = await prepareOffer(user, body);
        let offer;
        try {
            offer = await Offer.create({
                ...prepared.fields,
                statusHistory: [historyEntry("extended", user, prepared.note || "Offer extended")],
            });
        } catch (error) {
            if (error?.code === 11000) throw fail(409, "This application already has a live offer", "OFFER_EXISTS");
            throw error;
        }
        const plain = offer.toObject();
        await syncFromOffer(plain, { notify: false, actor: user });
        await events.offerCreated(plain);
        await emitOffer(plain, "created");
        return { offer: await staffView(plain._id, user) };
    });
};

// ── Reads ───────────────────────────────────────────────────────────────────

const STUDENT_ORDER = (offer) => {
    if (offer.status === "extended") return 0;
    if (offer.status === "accepted" || offer.status === "placed") return 1;
    return 2;
};

/** GET /offers/my → OfferStudentView[] (due offers are expired first). */
export const listMyOffers = async (user) => {
    if (user.role !== "student") throw fail(403, "Student account required", "FORBIDDEN");
    await expireDueOffersForStudent(user._id);
    const offers = await Offer.find({ student: user._id }).populate(STUDENT_OFFER_POPULATE).lean();
    offers.sort((a, b) => {
        const group = STUDENT_ORDER(a) - STUDENT_ORDER(b);
        if (group !== 0) return group;
        if (a.status === "extended") return new Date(a.expiresAt) - new Date(b.expiresAt);
        return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return studentViews(offers);
};

const offerFilter = async (user, query = {}) => {
    if (!isStaff(user) && user.role !== "company") throw fail(403, "Only the placement office and recruiters can list offers", "FORBIDDEN");
    const parts = [offerScope(user, { collegeId: user.role === "admin" ? query.collegeId : undefined })];
    if (query.academicYear !== undefined && query.academicYear !== "" && query.academicYear !== "all") {
        const year = String(query.academicYear).trim();
        if (!isValidAcademicYear(year)) throw invalid("academicYear", "academicYear must look like 2026-27");
        parts.push({ academicYear: year });
    }
    if (query.jobId !== undefined && query.jobId !== "") {
        assertObjectId(String(query.jobId), "jobId");
        parts.push({ job: toObjectId(query.jobId) });
    }
    const q = str(query.q, { field: "q", max: 200 });
    if (q) {
        const pattern = new RegExp(escapeRegex(q), "i");
        const students = await User.find({ role: "student", $or: [{ name: pattern }, { email: pattern }, { rollNumber: pattern }] })
            .select("_id").limit(500).lean();
        parts.push({ $or: [{ companyName: pattern }, { roleTitle: pattern }, { student: { $in: students.map((student) => student._id) } }] });
    }
    const base = andFilters(...parts);
    const statuses = enumList(query.status, OFFER_STATUSES, { field: "status" });
    return { base, filter: statuses ? andFilters(base, { status: { $in: statuses } }) : base };
};

const offerStatusCounts = async (filter) => {
    const rows = await Offer.aggregate([{ $match: filter }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    const counts = emptyOfferCounts();
    for (const row of rows) counts[row._id] = row.n;
    return counts;
};

/** GET /offers → {offers: OfferStaffView[], total, statusCounts}. */
export const listOffers = async (user, query = {}) => {
    const { base, filter } = await offerFilter(user, query);
    const limit = intParam(query.limit, { min: 1, max: 500, fallback: 200 });
    const page = intParam(query.page, { min: 1, max: 100000, fallback: 1 });
    const [total, statusCounts, offers] = await Promise.all([
        Offer.countDocuments(filter),
        offerStatusCounts(base),
        Offer.find(filter).populate(STAFF_OFFER_POPULATE).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return { offers: await staffViews(offers, user), total, statusCounts };
};

/** An offer in the caller's scope (404 otherwise). */
export const loadOfferInScope = async (user, offerId) => {
    assertObjectId(String(offerId ?? ""), "offerId");
    const offer = await Offer.findOne(andFilters({ _id: toObjectId(offerId) }, offerScope(user))).lean();
    if (!offer) throw notFound("Offer");
    return offer;
};

/** GET /offers/:id */
export const getOffer = async (user, offerId) => {
    const offer = await loadOfferInScope(user, offerId);
    if (user.role === "student" && offer.status === "extended" && new Date(offer.expiresAt) <= clock.now()) await expireOffer(offer);
    return viewOfferFor(user, offer._id);
};

// ── Staff edits ─────────────────────────────────────────────────────────────

/** PATCH /offers/:id (extended offers only). */
export const updateOffer = async (user, offerId, body = {}) => {
    if (!isStaff(user) && user.role !== "company") throw fail(403, "Only the placement office and recruiters can edit offers", "FORBIDDEN");
    const offer = await loadOfferInScope(user, offerId);
    if (offer.status !== "extended") throw fail(409, "Only pending offers can be edited", "INVALID_TRANSITION");
    const policy = await resolvePolicy(offer.college, offer.academicYear);
    const set = {};
    if (body.packageLpa !== undefined || body.ctc !== undefined) Object.assign(set, resolvePackage(body));
    const roleTitle = str(body.roleTitle, { field: "roleTitle", max: 200 });
    if (roleTitle) set.roleTitle = roleTitle;
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") set.expiresAt = resolveExpiry(body.expiresAt, policy);
    if (body.joiningDate !== undefined) set.joiningDate = optionalDay(body.joiningDate, "joiningDate") ?? null;
    if (body.location !== undefined) set.location = str(body.location, { field: "location", max: 200 }) ?? "";
    if (body.offerLetterUrl !== undefined) set.offerLetterUrl = httpsUrl(body.offerLetterUrl, { field: "offerLetterUrl" }) ?? null;
    const note = str(body.note, { field: "note", max: 500 }) ?? "";
    const best = await bestHeldPackage(offer.student, offer._id);
    set.offerType = classifyOffer(set.packageLpa ?? offer.packageLpa, best?.packageLpa ?? null, policy);

    const updated = await Offer.findOneAndUpdate(
        { _id: offer._id, status: "extended" },
        { $set: set, $push: { statusHistory: historyEntry("extended", user, note ? `Offer updated: ${note}` : "Offer updated") } },
        { returnDocument: "after", runValidators: true },
    ).lean();
    if (!updated) throw fail(409, "Only pending offers can be edited", "INVALID_TRANSITION");
    await events.offerUpdatedToStudent(updated, { edited: true, note: note || `${updated.roleTitle} · ${formatLpa(updated.packageLpa)} LPA` });
    await emitOffer(updated, "updated");
    return { offer: await staffView(updated._id, user) };
};

/** Recompute offerType for the student's remaining extended offers (after an accept). */
const reclassifyPendingOffers = async (studentId) => {
    const pending = await Offer.find({ student: studentId, status: "extended" }).select("packageLpa college academicYear offerType").lean();
    if (pending.length === 0) return;
    const best = await bestHeldPackage(studentId);
    for (const offer of pending) {
        const policy = await resolvePolicy(offer.college, offer.academicYear);
        const offerType = classifyOffer(offer.packageLpa, best?.packageLpa ?? null, policy);
        if (offerType !== offer.offerType) await Offer.updateOne({ _id: offer._id, status: "extended" }, { $set: { offerType } });
    }
};

// ── Student responses ───────────────────────────────────────────────────────

const loadOwnOffer = async (user, offerId) => {
    if (user.role !== "student") throw fail(403, "Only the student can respond to an offer", "FORBIDDEN");
    return loadOfferInScope(user, offerId);
};

const ensurePendingAndFresh = async (offer) => {
    if (offer.status === "extended" && new Date(offer.expiresAt).getTime() <= clock.now().getTime()) {
        await expireOffer(offer);
        throw fail(410, "This offer has expired", "OFFER_EXPIRED");
    }
    if (offer.status !== "extended") throw fail(409, `This offer is ${offerStatusLabel(offer.status).toLowerCase()}, not pending`, "OFFER_NOT_PENDING");
};

/**
 * Read-only accept check (also the offer_respond preview).
 * @returns {Promise<{offer, upgrade: boolean, held: object[], best: object|null, threshold: number|null, policy}>}
 */
export const checkAccept = async (user, offerId) => {
    const offer = await loadOwnOffer(user, offerId);
    await ensurePendingAndFresh(offer);
    const policy = await resolvePolicy(offer.college, offer.academicYear);
    const held = await Offer.find({ student: offer.student, _id: { $ne: offer._id }, status: { $in: HELD_OFFER_STATUSES } }).lean();
    let upgrade = false;
    let best = null;
    let threshold = null;
    if (held.length > 0 && policy.enforceOneOffer) {
        best = held.reduce((top, entry) => (entry.packageLpa > top.packageLpa ? entry : top), held[0]);
        threshold = round2(best.packageLpa * policy.dreamMultiplier);
        if (policy.allowDreamUpgrade && offer.packageLpa >= threshold) upgrade = true;
        else {
            const message = policy.allowDreamUpgrade
                ? `You have already accepted ${best.companyName} (${formatLpa(best.packageLpa)} LPA). Under the one-offer policy you can only accept a dream offer of at least ${formatLpa(threshold)} LPA.`
                : `You have already accepted ${best.companyName} (${formatLpa(best.packageLpa)} LPA). The one-offer policy does not allow accepting another offer.`;
            throw fail(409, message, "ONE_OFFER_POLICY", { currentAcceptedPackage: best.packageLpa, requiredPackageLpa: threshold });
        }
    }
    return { offer, upgrade, held: upgrade ? held : [], best, threshold, policy };
};

/** POST /offers/:id/accept → {offer: OfferStudentView, released: [{_id, companyName, packageLpa}]} */
export const acceptOffer = async (user, offerId) => {
    assertObjectId(String(offerId ?? ""), "offerId");
    return withLock(`offers:${user._id}`, async () => {
        const { offer, upgrade, held } = await checkAccept(user, offerId);
        const now = clock.now();
        const accepted = await Offer.findOneAndUpdate(
            { _id: offer._id, status: "extended" },
            { $set: { status: "accepted", respondedAt: now }, $push: { statusHistory: historyEntry("accepted", user, "Offer accepted") } },
            { returnDocument: "after" },
        ).lean();
        if (!accepted) throw fail(409, "This offer is no longer pending", "OFFER_NOT_PENDING");

        const released = [];
        if (upgrade) {
            const releaseNote = `Released after accepting a dream offer from ${accepted.companyName}`;
            for (const entry of held) {
                const releasedOffer = await Offer.findOneAndUpdate(
                    { _id: entry._id, status: { $in: HELD_OFFER_STATUSES } },
                    { $set: { status: "withdrawn", responseReason: releaseNote }, $push: { statusHistory: historyEntry("withdrawn", user, releaseNote) } },
                    { returnDocument: "after" },
                ).lean();
                if (!releasedOffer) continue;
                released.push({ _id: idOf(releasedOffer._id), companyName: releasedOffer.companyName, packageLpa: releasedOffer.packageLpa });
                await syncFromOffer(releasedOffer, { byStudent: true, note: releaseNote, actor: user });
                events.offerResponseToStaff(releasedOffer, { studentName: user.name, reason: releaseNote });
                await emitOffer(releasedOffer, "released");
            }
        }
        await syncFromOffer(accepted, { byStudent: true, actor: user });
        await reclassifyPendingOffers(user._id);
        events.offerResponseToStaff(accepted, { studentName: user.name });
        await emitOffer(accepted, "accepted");
        return { offer: await studentView(accepted._id), released };
    });
};

/** POST /offers/:id/reject */
export const rejectOffer = async (user, offerId, { reason } = {}) => {
    assertObjectId(String(offerId ?? ""), "offerId");
    const cleanReason = str(reason, { field: "reason", max: 500 }) ?? "";
    return withLock(`offers:${user._id}`, async () => {
        const offer = await loadOwnOffer(user, offerId);
        await ensurePendingAndFresh(offer);
        const updated = await Offer.findOneAndUpdate(
            { _id: offer._id, status: "extended" },
            {
                $set: { status: "rejected", respondedAt: clock.now(), responseReason: cleanReason },
                $push: { statusHistory: historyEntry("rejected", user, cleanReason || "Offer declined") },
            },
            { returnDocument: "after" },
        ).lean();
        if (!updated) throw fail(409, "This offer is no longer pending", "OFFER_NOT_PENDING");
        await syncFromOffer(updated, { byStudent: true, actor: user });
        await reclassifyPendingOffers(user._id);
        events.offerResponseToStaff(updated, { studentName: user.name, reason: cleanReason });
        await emitOffer(updated, "rejected");
        return { offer: await studentView(updated._id) };
    });
};

/** POST /offers/:id/withdraw (student, only from accepted). */
export const withdrawOffer = async (user, offerId, { reason } = {}) => {
    assertObjectId(String(offerId ?? ""), "offerId");
    const cleanReason = str(reason, { field: "reason", max: 500 }) ?? "";
    return withLock(`offers:${user._id}`, async () => {
        const offer = await loadOwnOffer(user, offerId);
        if (offer.status !== "accepted") throw fail(409, "Only an accepted offer can be withdrawn", "INVALID_TRANSITION");
        const updated = await Offer.findOneAndUpdate(
            { _id: offer._id, status: "accepted" },
            {
                $set: { status: "withdrawn", respondedAt: clock.now(), responseReason: cleanReason },
                $push: { statusHistory: historyEntry("withdrawn", user, cleanReason || "Offer acceptance withdrawn") },
            },
            { returnDocument: "after" },
        ).lean();
        if (!updated) throw fail(409, "Only an accepted offer can be withdrawn", "INVALID_TRANSITION");
        await syncFromOffer(updated, { byStudent: true, actor: user });
        await reclassifyPendingOffers(user._id);
        events.offerResponseToStaff(updated, { studentName: user.name, reason: cleanReason });
        await emitOffer(updated, "withdrawn");
        return { offer: await studentView(updated._id) };
    });
};

// ── Placement office actions ────────────────────────────────────────────────

/** POST /offers/:id/place (tpo): accepted → placed. */
export const placeOffer = async (user, offerId) => {
    if (!isStaff(user)) throw fail(403, "Only the placement office can confirm placements", "FORBIDDEN");
    const offer = await loadOfferInScope(user, offerId);
    if (offer.status !== "accepted") throw fail(409, "Only an accepted offer can be marked as placed", "INVALID_TRANSITION");
    const updated = await Offer.findOneAndUpdate(
        { _id: offer._id, status: "accepted" },
        { $set: { status: "placed", placedAt: clock.now() }, $push: { statusHistory: historyEntry("placed", user, "Placement confirmed") } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) throw fail(409, "Only an accepted offer can be marked as placed", "INVALID_TRANSITION");
    await syncFromOffer(updated, { notify: false, actor: user });
    await events.offerUpdatedToStudent(updated, { note: `You are officially placed at ${updated.companyName}` });
    await emitOffer(updated, "placed");
    return { offer: await staffView(updated._id, user) };
};

/** POST /offers/:id/override (tpo): any status → another; the policy is not enforced. */
export const overrideOffer = async (user, offerId, { newStatus, note } = {}) => {
    if (!isStaff(user)) throw fail(403, "Only the placement office can override offers", "FORBIDDEN");
    const target = oneOf(newStatus, OFFER_STATUSES, { field: "newStatus", required: true });
    const cleanNote = str(note, { field: "note", min: 3, max: 500, required: true });
    const offer = await loadOfferInScope(user, offerId);
    if (offer.status === target) throw invalid("newStatus", `The offer is already ${offerStatusLabel(target).toLowerCase()}`);
    const now = clock.now();
    const set = { status: target, tpoOverride: true };
    if (target === "placed") set.placedAt = now;
    if (["accepted", "rejected", "withdrawn"].includes(target)) set.respondedAt = now;
    if (target === "extended" && new Date(offer.expiresAt).getTime() <= now.getTime()) {
        const policy = await resolvePolicy(offer.college, offer.academicYear);
        set.expiresAt = endOfDay(addDays(now, policy.offerExpiryDays));
        set.reminderSentAt = null;
    }
    const updated = await Offer.findOneAndUpdate(
        { _id: offer._id, status: offer.status },
        { $set: set, $push: { statusHistory: historyEntry(target, user, `TPO override: ${cleanNote}`) } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) throw fail(409, "The offer changed while it was being updated; reload and try again", "INVALID_TRANSITION");
    await syncFromOffer(updated, { notify: false, actor: user, note: `TPO override: ${cleanNote}` });
    await reclassifyPendingOffers(updated.student);
    await events.offerUpdatedToStudent(updated, { note: `TPO override: ${cleanNote}` });
    await emitOffer(updated, "override");
    return { offer: await staffView(updated._id, user) };
};

/** POST /offers/:id/revoke (tpo, company): extended|accepted → withdrawn; the application → rejected. */
export const revokeOffer = async (user, offerId, { reason } = {}) => {
    if (!isStaff(user) && user.role !== "company") throw fail(403, "Only the placement office and recruiters can revoke offers", "FORBIDDEN");
    const cleanReason = str(reason, { field: "reason", min: 3, max: 500, required: true });
    const offer = await loadOfferInScope(user, offerId);
    if (!["extended", "accepted"].includes(offer.status)) throw fail(409, "Only pending or accepted offers can be revoked", "INVALID_TRANSITION");
    const note = `Offer revoked: ${cleanReason}`;
    const updated = await Offer.findOneAndUpdate(
        { _id: offer._id, status: offer.status },
        { $set: { status: "withdrawn", responseReason: cleanReason }, $push: { statusHistory: historyEntry("withdrawn", user, note) } },
        { returnDocument: "after" },
    ).lean();
    if (!updated) throw fail(409, "Only pending or accepted offers can be revoked", "INVALID_TRANSITION");
    await syncFromOffer(updated, { notify: false, revoked: true, note, actor: user });
    await reclassifyPendingOffers(updated.student);
    await events.offerUpdatedToStudent(updated, { note });
    await emitOffer(updated, "revoked");
    return { offer: await staffView(updated._id, user) };
};

export const isOfferId = (value) => isObjectId(String(value ?? ""));
