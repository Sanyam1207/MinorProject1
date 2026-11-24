// Enums, labels and the application transition table (docs/contracts/PLACEMENTS.md §3, §5, §7, §9).
import { fail } from "../../core/http.js";

export const STAFF_ROLES = Object.freeze(["tpo", "admin"]);
export const isStaff = (user) => STAFF_ROLES.includes(user?.role);
export const isRecruiter = (user) => user?.role === "company";
export const isStudent = (user) => user?.role === "student";

// ── Drives ──────────────────────────────────────────────────────────────────
export const DRIVE_STATUSES = Object.freeze(["draft", "pending", "active", "closed", "rejected"]);
export const ROUND_MODES = Object.freeze(["online", "offline"]);
export const DRIVE_CREATOR_ROLES = Object.freeze(["tpo", "admin", "company"]);

// ── Applications ────────────────────────────────────────────────────────────
export const APPLICATION_STATUSES = Object.freeze(["applied", "shortlisted", "interview", "offered", "hired", "rejected", "withdrawn"]);
export const APPLICATION_STATUS_LABELS = Object.freeze({
    applied: "Applied",
    shortlisted: "Shortlisted",
    interview: "Interview",
    offered: "Offer received",
    hired: "Hired",
    rejected: "Not selected",
    withdrawn: "Withdrawn",
});
export const statusLabel = (status) => APPLICATION_STATUS_LABELS[status] || status || "";
/** Pipeline order used by `sort=status` and applicants_list. */
export const PIPELINE_ORDER = Object.freeze(Object.fromEntries(APPLICATION_STATUSES.map((status, index) => [status, index])));
export const LIVE_APPLICATION_STATUSES = Object.freeze(["applied", "shortlisted", "interview"]);
export const STAFF_SETTABLE_STATUSES = Object.freeze(["applied", "shortlisted", "interview", "rejected"]);
export const ELIGIBILITY_SNAPSHOT_STATUSES = Object.freeze(["eligible", "ineligible", "incomplete", "override", "unknown"]);
export const APPLICATION_SOURCES = Object.freeze(["web", "agent", "tpo", "migrated"]);

/** Default notification bodies for placement.application.status (§9). */
export const APPLICATION_STATUS_BODIES = Object.freeze({
    applied: "Your application is back under review.",
    shortlisted: "You have been shortlisted. Watch for interview details.",
    interview: "You have been moved to the interview round.",
    rejected: "Thank you for applying. You were not selected this time.",
    offered: "You have an offer. Open My Offers to respond.",
    hired: "Congratulations! Your offer is confirmed.",
    withdrawn: "Your application was withdrawn.",
});

const USE_OFFER_FLOW_MESSAGE = "Create or change the offer instead (POST /offers or offer_create)";

/**
 * Staff status change rule (§7.2). Returns null when allowed, otherwise the ApiError to throw.
 * `from === to` is allowed here (the caller answers `{changed:false}`).
 */
export const transitionError = (from, to, role) => {
    if (to === "offered" || to === "hired" || from === "offered" || from === "hired") {
        return fail(409, USE_OFFER_FLOW_MESSAGE, "USE_OFFER_FLOW");
    }
    if (!STAFF_SETTABLE_STATUSES.includes(to)) {
        return fail(400, `status must be one of: ${STAFF_SETTABLE_STATUSES.join(", ")}`, "VALIDATION", { field: "status" });
    }
    if (from === to) return null;
    if (from === "withdrawn") {
        return fail(409, "The student withdrew this application; it cannot be changed", "INVALID_TRANSITION");
    }
    if (from === "rejected" && !STAFF_ROLES.includes(role)) {
        return fail(409, "Only the placement office can reopen a rejected application", "INVALID_TRANSITION");
    }
    if (!STAFF_SETTABLE_STATUSES.includes(from)) {
        return fail(409, `An application in status "${from}" cannot be changed`, "INVALID_TRANSITION");
    }
    return null;
};

/** Boolean form of the §7.2 table (unit tests and previews). */
export const canTransition = (from, to, role) => transitionError(from, to, role) === null;

// ── Offers ──────────────────────────────────────────────────────────────────
export const OFFER_STATUSES = Object.freeze(["extended", "accepted", "rejected", "withdrawn", "expired", "placed"]);
export const OFFER_TYPES = Object.freeze(["normal", "dream", "super-dream"]);
export const OFFER_STATUS_LABELS = Object.freeze({
    extended: "Pending response",
    accepted: "Accepted",
    rejected: "Declined",
    withdrawn: "Withdrawn",
    expired: "Expired",
    placed: "Placed",
});
export const offerStatusLabel = (status) => OFFER_STATUS_LABELS[status] || status || "";
export const HELD_OFFER_STATUSES = Object.freeze(["accepted", "placed"]);
export const LIVE_OFFER_STATUSES = Object.freeze(["extended", "accepted", "placed"]);

// ── Policy ──────────────────────────────────────────────────────────────────
export const DEFAULT_POLICY = Object.freeze({
    enforceOneOffer: true,
    allowDreamUpgrade: true,
    dreamMultiplier: 1.5,
    superDreamMultiplier: 2.0,
    maxPendingOffers: 3,
    offerExpiryDays: 7,
});

// ── Training ────────────────────────────────────────────────────────────────
export const TRAINING_TYPES = Object.freeze(["aptitude", "technical", "soft-skills", "certification", "workshop", "mock-interview", "other"]);
export const DELIVERY_MODES = Object.freeze(["online", "offline", "hybrid"]);
export const PROGRAM_STATUSES = Object.freeze(["upcoming", "ongoing", "completed", "cancelled"]);
export const ENROLLMENT_STATUSES = Object.freeze(["registered", "cancelled"]);
export const COMPLETION_STATUSES = Object.freeze(["enrolled", "in-progress", "completed", "dropped"]);
export const ATTENDANCE_METHODS = Object.freeze(["manual", "qr"]);

// ── Announcements ───────────────────────────────────────────────────────────
export const ANNOUNCE_ROLES = Object.freeze(["student", "teacher", "alumni", "company", "tpo"]);
