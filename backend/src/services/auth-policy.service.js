// Who may sign in or register, and as what (docs/contracts/AUTH-FACULTY.md §1, §4).
//
// Golden rule: an EXISTING user always signs in with their STORED role. The
// requested role only matters when a brand-new account is being registered.
// TPO_EMAIL is reserved for the TPO; TEACHER_EMAILS always register as teachers.
import crypto from "node:crypto";
import {
    GOOGLE_REQUIRE_HOSTED_DOMAIN,
    TEACHER_EMAILS,
    TPO_EMAIL,
    TPO_INITIAL_PASSWORD,
} from "../config/config.js";
import { College } from "../models/college.models.js";
import { ApiError } from "../utils/api-error.js";
import { findCollegeForEmail, linkStudentToCollege } from "../utils/student-college.js";

const apiError = (status, message, code, extra = {}) => new ApiError(status, message, [{ code, ...extra }]);

/**
 * One-line structured log for identity events, e.g.
 * `[auth] login {"userId":"…","role":"student","via":"password"}`.
 * Callers pass ids, roles and masked emails only — never passwords, tokens,
 * reset links or temporary passwords. Quiet under NODE_ENV=test unless
 * AUTH_TEST_LOGS=true (used by tests that assert what is logged).
 */
export const logAuthEvent = (scope, event, fields = {}, level = "info") => {
    if (process.env.NODE_ENV === "test" && process.env.AUTH_TEST_LOGS !== "true") return;
    let details = "";
    try {
        details = JSON.stringify(fields);
    } catch {
        details = "";
    }
    (console[level] || console.info)(`[${scope}] ${event}${details && details !== "{}" ? ` ${details}` : ""}`);
};

/** Test seam for settings that config.js reads once at import. */
export const authPolicySettings = {
    requireHostedDomain: GOOGLE_REQUIRE_HOSTED_DOMAIN,
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX_LENGTH = 254;
export const SELF_SERVICE_ROLES = Object.freeze(["student", "teacher", "tpo", "company", "alumni", "admin"]);

/** Trimmed, lowercased email, or null when it is not a plausible address (≤ 254 chars). */
export const normalizeEmail = (value) => {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) return null;
    return email;
};

/** "a***@demo.edu" — safe to log or show to someone holding a reset link. */
export const maskEmail = (email) => {
    const [local = "", domain = ""] = String(email || "").split("@");
    if (!domain) return "***";
    return `${local.slice(0, 1) || "*"}***@${domain}`;
};

/** Role aliases accepted in request bodies: faculty → teacher, recruiter → company. Unknown → null. */
export const aliasRole = (value) => {
    if (typeof value !== "string") return null;
    const role = value.trim().toLowerCase();
    if (role === "faculty") return "teacher";
    if (role === "recruiter") return "company";
    return SELF_SERVICE_ROLES.includes(role) ? role : null;
};

export const isTeacherEmail = (email) => Boolean(email) && TEACHER_EMAILS.has(String(email).trim().toLowerCase());

export const isReservedTpoEmail = (email) => Boolean(TPO_EMAIL) && email === TPO_EMAIL;

/** Title-cased local part: "anita.sharma@x" → "Anita Sharma". */
export const nameFromEmail = (email) => String(email || "")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "User";

const matchesConfiguredTpoPassword = (password) => {
    if (!TPO_INITIAL_PASSWORD || typeof password !== "string") return false;
    const supplied = crypto.createHash("sha256").update(password).digest();
    const configured = crypto.createHash("sha256").update(TPO_INITIAL_PASSWORD).digest();
    return crypto.timingSafeEqual(supplied, configured);
};

const hostedDomainCheck = ({ via, googlePayload, domain }) => {
    if (via !== "google" || !authPolicySettings.requireHostedDomain) return;
    if (!googlePayload || googlePayload.hd !== domain) {
        throw apiError(403, `Sign in with your ${domain} Google Workspace account.`, "HOSTED_DOMAIN_REQUIRED");
    }
};

/**
 * Atomically claim `college.tpo` for `userId`. Idempotent for the holder.
 * Throws 409 TPO_EXISTS when another user holds the slot.
 */
export const claimCollegeTpoSlot = async (college, userId) => {
    if (!college?._id || !userId) return false;
    if (college.tpo && String(college.tpo) === String(userId)) return true;
    const claimed = await College.findOneAndUpdate(
        { _id: college._id, $or: [{ tpo: null }, { tpo: { $exists: false } }] },
        { $set: { tpo: userId } },
        { returnDocument: "after" },
    );
    if (!claimed) {
        const current = await College.findById(college._id).select("tpo").lean();
        if (current?.tpo && String(current.tpo) === String(userId)) return true;
        throw apiError(409, "This college already has a registered TPO account.", "TPO_EXISTS");
    }
    return true;
};

/**
 * Decide the role and college of a brand-new account. Throws the §4.1 errors.
 * @param {{email: string, requestedRole?: string, password?: string, via: "password"|"google", googlePayload?: object}} input
 * @returns {Promise<{role: string, college: object|null}>}
 */
export const resolveRegistration = async ({ email, requestedRole = "student", password, via, googlePayload }) => {
    const domain = email.split("@")[1];
    let college = await findCollegeForEmail(email);

    if (isReservedTpoEmail(email)) {
        if (via === "password") {
            if (!TPO_EMAIL || !TPO_INITIAL_PASSWORD) {
                throw apiError(503, "TPO registration is not configured on this server.", "TPO_BOOTSTRAP_DISABLED");
            }
            if (!matchesConfiguredTpoPassword(password)) {
                throw apiError(403, "This email is not approved for TPO registration.", "TPO_NOT_APPROVED");
            }
        }
        // via "google": a verified Google email is enough.
        college ??= await College.findOneAndUpdate(
            { domain },
            { $setOnInsert: { name: domain.split(".")[0].toUpperCase(), domain } },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
        );
        if (college.tpo) throw apiError(409, "This college already has a registered TPO account.", "TPO_EXISTS");
        return { role: "tpo", college };
    }

    if (isTeacherEmail(email)) {
        if (!college) {
            throw apiError(
                400,
                "Teacher self-registration needs an email on a registered college domain. Ask your TPO to invite you.",
                "INVALID_DOMAIN",
            );
        }
        hostedDomainCheck({ via, googlePayload, domain });
        return { role: "teacher", college };
    }

    switch (requestedRole) {
        case "alumni":
            return { role: "alumni", college: null };
        case "teacher":
            throw apiError(
                403,
                "Faculty accounts are created by your placement office. Ask your TPO to invite you.",
                "TEACHER_INVITE_REQUIRED",
            );
        case "company":
            throw apiError(403, "Recruiter accounts are created by the placement office.", "RECRUITER_INVITE_REQUIRED");
        case "tpo":
            throw apiError(403, "This email is not approved for TPO registration.", "TPO_NOT_APPROVED");
        case "admin":
            throw apiError(403, "Administrator accounts cannot be registered.", "ROLE_NOT_ALLOWED");
        default:
            if (!college) {
                throw apiError(400, "INVALID DOMAIN: Use an email domain registered to a college", "INVALID_DOMAIN");
            }
            hostedDomainCheck({ via, googlePayload, domain });
            return { role: "student", college };
    }
};

/**
 * Account-state checks after the credential was verified.
 * `via: "password"` also enforces the temporary-password expiry.
 */
export const assertLoginAllowed = (user, { via = "password", now = new Date() } = {}) => {
    if (user.isActive === false) {
        throw apiError(403, "This account has been deactivated. Contact your placement office.", "ACCOUNT_DISABLED");
    }
    if (via === "password" && user.mustChangePassword && user.tempPasswordExpiresAt
        && new Date(user.tempPasswordExpiresAt).getTime() < now.getTime()) {
        throw apiError(
            401,
            "Your temporary password has expired. Ask your placement office for a new invite.",
            "TEMP_PASSWORD_EXPIRED",
        );
    }
};

/**
 * Role housekeeping on every successful login. Never fails the login.
 * - student: link to the college (user.college, else the email domain) and fill collegeName.
 * - tpo: set user.college from the domain and claim a free TPO slot.
 */
export const afterLogin = async (user) => {
    try {
        if (user.role === "student") {
            const college = user.college
                ? await College.findById(user.college)
                : await findCollegeForEmail(user.email);
            if (college) {
                await linkStudentToCollege(user, college);
                if (!user.collegeName && college.name) {
                    user.collegeName = college.name;
                    await user.save({ validateBeforeSave: false });
                }
            }
        } else if (user.role === "tpo") {
            let college = user.college ? await College.findById(user.college) : null;
            if (!college) {
                college = await findCollegeForEmail(user.email);
                if (college) {
                    user.college = college._id;
                    if (!user.collegeName && college.name) user.collegeName = college.name;
                    await user.save({ validateBeforeSave: false });
                }
            }
            if (college && !college.tpo) {
                await claimCollegeTpoSlot(college, user._id).catch(() => false);
            }
        }
    } catch (error) {
        logAuthEvent("auth", "post-login housekeeping failed", { userId: String(user._id), error: error?.message || String(error) }, "warn");
    }
};
