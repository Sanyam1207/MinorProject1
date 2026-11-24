// Faculty (role "teacher") and recruiter (role "company") provisioning by the
// TPO or an admin (docs/contracts/AUTH-FACULTY.md §7).
//
// Accounts are created with a one-time temporary password (mustChangePassword)
// that is emailed when SMTP works, otherwise returned once in the HTTP response
// ("manual" delivery). It is never stored in plain text, logged, or put into a
// copilot tool result.
//
// Scope: a TPO sees and manages only accounts of their own college; an admin
// works on `collegeId` (or their own college; all colleges for lists). An
// account outside the caller's scope is 404 NOT_FOUND (never "forbidden").
import mongoose from "mongoose";
import { APP_NAME, TEMP_PASSWORD_TTL_DAYS } from "../../config/config.js";
import { escapeRegex, fail, intParam, isObjectId } from "../../core/http.js";
import { College } from "../../models/college.models.js";
import { Company } from "../../models/company.models.js";
import { User } from "../../models/user.models.js";
import { accountMailer, sendInviteEmail } from "../../services/account-mail.service.js";
import { isReservedTpoEmail, logAuthEvent, normalizeEmail } from "../../services/auth-policy.service.js";
import { invalidateUserAccess } from "../../services/auth-session.service.js";
import { canonicalBranch } from "../../utils/branch.js";
import { generateTemporaryPassword } from "../../utils/password.js";
import { notify } from "../notifications/notify.js";

export const KINDS = Object.freeze({
    teacher: Object.freeze({ role: "teacher", noun: "faculty member", mailKind: "faculty" }),
    company: Object.freeze({ role: "company", noun: "recruiter", mailKind: "recruiter" }),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUSES = ["active", "inactive", "all"];
const SEARCH_MAX = 100;

const notFound = (kind) => fail(404, `${kind === "company" ? "Recruiter" : "Faculty member"} not found`, "NOT_FOUND");
const validation = (field, message) => fail(400, message, "VALIDATION", { field });
const kindOf = (kind) => {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`Unknown provisioning kind "${kind}"`);
    return spec;
};

// ── College scope (§7.1) ────────────────────────────────────────────────────

const collegeView = (college) => (college ? { _id: college._id, name: college.name || college.domain, domain: college.domain } : null);

/**
 * The college the actor works on.
 * - tpo: their own college (409 NO_COLLEGE when unlinked)
 * - admin: `collegeId` (404 when unknown), else their own; none → null (all
 *   colleges) for reads, 400 COLLEGE_REQUIRED for `purpose: "create"`.
 */
export const resolveActorCollege = async (actor, collegeId, { purpose = "read" } = {}) => {
    if (actor?.role === "tpo") {
        const college = actor.college ? await College.findById(actor.college).select("name domain").lean() : null;
        if (!college) throw fail(409, "Your account is not linked to a college", "NO_COLLEGE");
        return college;
    }
    if (actor?.role === "admin") {
        if (collegeId !== undefined && collegeId !== null && collegeId !== "") {
            const college = isObjectId(String(collegeId))
                ? await College.findById(String(collegeId)).select("name domain").lean()
                : null;
            if (!college) throw fail(404, "College not found", "NOT_FOUND");
            return college;
        }
        if (actor.college) {
            const college = await College.findById(actor.college).select("name domain").lean();
            if (college) return college;
        }
        if (purpose === "create") {
            throw fail(400, "Choose the college for this account (collegeId).", "COLLEGE_REQUIRED");
        }
        return null;
    }
    throw fail(403, "This action requires the TPO role", "FORBIDDEN");
};

const scopeFilter = (kind, college) => ({
    role: kindOf(kind).role,
    ...(college ? { college: college._id } : {}),
});

// ── DTOs ────────────────────────────────────────────────────────────────────

const POPULATE = [
    { path: "invitedBy", select: "name" },
    { path: "college", select: "name domain" },
    { path: "company", select: "name" },
];

const refView = (value, fields) => {
    if (!value || typeof value !== "object" || !value._id) return null;
    const view = { _id: value._id };
    for (const field of fields) view[field] = value[field] ?? null;
    return view;
};

const commonView = (user) => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    designation: user.designation ?? null,
    isActive: user.isActive !== false,
    authProvider: user.authProvider || "local",
    mustChangePassword: user.mustChangePassword === true,
    inviteExpiresAt: user.mustChangePassword ? (user.tempPasswordExpiresAt ?? null) : null,
    invitedBy: refView(user.invitedBy, ["name"]),
    invitedAt: user.invitedAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    deactivatedAt: user.deactivatedAt ?? null,
    college: refView(user.college, ["name", "domain"]),
});

/** FacultyDTO (§7.2). `courseCount` only when the Course model is registered. */
export const toFacultyDTO = (user, courseCount) => ({
    ...commonView(user),
    role: "teacher",
    department: user.department ?? null,
    employeeId: user.employeeId ?? null,
    ...(courseCount !== undefined ? { courseCount } : {}),
});

/** RecruiterDTO (§7.3). */
export const toRecruiterDTO = (user) => ({
    ...commonView(user),
    role: "company",
    company: refView(user.company, ["name"]),
});

const toDTO = (kind, user, courseCount) => (kind === "company" ? toRecruiterDTO(user) : toFacultyDTO(user, courseCount));

/** Active-course counts per teacher (one aggregate), or null when attendance is not installed. */
const courseCounts = async (teacherIds) => {
    const Course = mongoose.models.Course;
    if (!Course || teacherIds.length === 0) return null;
    try {
        const rows = await Course.aggregate([
            { $match: { teacher: { $in: teacherIds }, status: "active" } },
            { $group: { _id: "$teacher", count: { $sum: 1 } } },
        ]);
        return new Map(rows.map((row) => [String(row._id), row.count]));
    } catch (error) {
        logAuthEvent("faculty", "course counts unavailable", { error: error?.message || String(error) }, "warn");
        return null;
    }
};

const toDTOs = async (kind, users) => {
    if (kind !== "teacher") return users.map((user) => toDTO(kind, user));
    const counts = await courseCounts(users.map((user) => user._id));
    return users.map((user) => toFacultyDTO(user, counts ? (counts.get(String(user._id)) ?? 0) : undefined));
};

// ── Input validation ────────────────────────────────────────────────────────

const optionalText = (value, field, max, label) => {
    if (value === undefined) return undefined;
    if (value === null) return "";
    if (typeof value !== "string" && typeof value !== "number") throw validation(field, `${label} must be text`);
    const text = String(value).trim();
    if (text.length > max) throw validation(field, `${label} must be at most ${max} characters`);
    return text;
};

const requiredName = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length < 2 || text.length > 80) throw validation("name", "Name must be 2–80 characters");
    return text;
};

const departmentValue = (value) => {
    const text = optionalText(value, "department", 60, "Department");
    if (text === undefined) return undefined;
    return text ? canonicalBranch(text) : "";
};

const companyRef = (input) => {
    const hasId = input.companyId !== undefined && input.companyId !== null && input.companyId !== "";
    const hasName = input.companyName !== undefined && input.companyName !== null && String(input.companyName).trim() !== "";
    if (hasId === hasName) return null;
    if (hasId) {
        if (!isObjectId(String(input.companyId))) throw validation("companyId", "companyId must be a valid id");
        return { companyId: String(input.companyId) };
    }
    const companyName = optionalText(input.companyName, "companyName", 120, "Company name");
    if (!companyName) throw validation("companyName", "Company name is required");
    return { companyName };
};

/** Normalised invite arguments for `kind`; throws 400 VALIDATION {field}. */
export const validateInviteInput = (kind, input = {}) => {
    kindOf(kind);
    const body = input && typeof input === "object" ? input : {};
    const name = requiredName(body.name);
    const email = normalizeEmail(body.email);
    if (!email) throw validation("email", "Enter a valid email address");
    const args = { name, email };
    const designation = optionalText(body.designation, "designation", 80, "Designation");
    if (designation) args.designation = designation;
    if (kind === "teacher") {
        const department = departmentValue(body.department);
        if (department) args.department = department;
        const employeeId = optionalText(body.employeeId, "employeeId", 40, "Employee ID");
        if (employeeId) args.employeeId = employeeId;
    } else {
        const ref = companyRef(body);
        if (!ref) throw validation("companyName", "Give exactly one of companyName or companyId");
        Object.assign(args, ref);
    }
    return args;
};

/** 409 EMAIL_RESERVED for TPO_EMAIL, 409 EMAIL_EXISTS when any account has the email. */
export const assertEmailAvailable = async (email) => {
    if (isReservedTpoEmail(email)) {
        throw fail(409, "This email is reserved for the placement office (TPO) account.", "EMAIL_RESERVED");
    }
    const existing = await User.findOne({ email }).select("role isActive").lean();
    if (existing) {
        throw fail(409, `An account with this email already exists (${existing.role}).`, "EMAIL_EXISTS", {
            existingRole: existing.role,
            existingActive: existing.isActive !== false,
        });
    }
};

/**
 * Find (or, with `create`, create) the Company for `{companyId}` or
 * `{companyName}` (case-insensitive exact name). 404 for an unknown id.
 * Without `create`, an unknown name returns `{_id: null, name}`.
 */
export const resolveCompany = async ({ companyId, companyName }, { create = false } = {}) => {
    if (companyId) {
        const company = await Company.findById(companyId).select("name").lean();
        if (!company) throw fail(404, "Company not found", "NOT_FOUND");
        return company;
    }
    const name = String(companyName).trim();
    const existing = await Company.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } })
        .sort({ createdAt: 1 }).select("name").lean();
    if (existing) return existing;
    if (!create) return { _id: null, name };
    const created = await Company.create({ name });
    return { _id: created._id, name: created.name };
};

// ── Listing ─────────────────────────────────────────────────────────────────

const buildListFilter = async (kind, college, { search, department, company, status = "all" } = {}) => {
    const filter = scopeFilter(kind, college);
    const statusValue = typeof status === "string" && status.trim() ? status.trim().toLowerCase() : "all";
    if (!STATUSES.includes(statusValue)) throw validation("status", "status must be active, inactive or all");
    if (statusValue === "active") filter.isActive = { $ne: false };
    if (statusValue === "inactive") filter.isActive = false;

    if (typeof search === "string" && search.trim()) {
        const pattern = escapeRegex(search.trim().slice(0, SEARCH_MAX));
        filter.$or = [{ name: { $regex: pattern, $options: "i" } }, { email: { $regex: pattern, $options: "i" } }];
    }
    if (kind === "teacher" && typeof department === "string" && department.trim()) {
        filter.department = { $regex: `^${escapeRegex(canonicalBranch(department))}$`, $options: "i" };
    }
    if (kind === "company" && typeof company === "string" && company.trim()) {
        const value = company.trim();
        if (isObjectId(value)) {
            // Cast explicitly: the same filter also feeds an aggregate (no auto-casting there).
            filter.company = new mongoose.Types.ObjectId(value);
        } else {
            const companies = await Company.find({ name: { $regex: escapeRegex(value.slice(0, SEARCH_MAX)), $options: "i" } })
                .select("_id").limit(500).lean();
            filter.company = { $in: companies.map((entry) => entry._id) };
        }
    }
    return { filter, status: statusValue };
};

/**
 * Paginated list in the actor's scope.
 * @returns {Promise<{items: object[], total: number, page: number, limit: number, college: object|null, status: string}>}
 */
export const listProvisioned = async ({ actor, kind, query = {} }) => {
    const college = await resolveActorCollege(actor, query.collegeId, { purpose: "list" });
    const { filter, status } = await buildListFilter(kind, college, query);
    const page = intParam(query.page, { min: 1, max: 10_000, fallback: 1 });
    const limit = intParam(query.limit, { min: 1, max: 100, fallback: 50 });
    const [total, users] = await Promise.all([
        User.countDocuments(filter),
        User.find(filter)
            .select("name email role department designation employeeId isActive authProvider mustChangePassword tempPasswordExpiresAt invitedBy invitedAt lastLoginAt deactivatedAt college company")
            .sort({ isActive: -1, name: 1, _id: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate(POPULATE)
            .lean(),
    ]);
    return { items: await toDTOs(kind, users), total, page, limit, college: collegeView(college), status };
};

/** Counts for copilot summaries: {total, active, groups: [{label, count}]} grouped by department or company. */
export const summarizeProvisioned = async ({ actor, kind, query = {} }) => {
    const college = await resolveActorCollege(actor, query.collegeId, { purpose: "list" });
    const { filter } = await buildListFilter(kind, college, query);
    const groupKey = kind === "teacher" ? "$department" : "$company";
    const rows = await User.aggregate([
        { $match: filter },
        {
            $group: {
                _id: groupKey,
                count: { $sum: 1 },
                active: { $sum: { $cond: [{ $eq: ["$isActive", false] }, 0, 1] } },
            },
        },
        { $sort: { count: -1 } },
    ]);
    let labels = new Map();
    if (kind === "company") {
        const ids = rows.map((row) => row._id).filter(Boolean);
        const companies = ids.length ? await Company.find({ _id: { $in: ids } }).select("name").lean() : [];
        labels = new Map(companies.map((company) => [String(company._id), company.name]));
    }
    const groups = rows.map((row) => ({
        label: kind === "company" ? (labels.get(String(row._id)) || "other") : (row._id || "other"),
        count: row.count,
    }));
    return {
        total: rows.reduce((sum, row) => sum + row.count, 0),
        active: rows.reduce((sum, row) => sum + row.active, 0),
        groups,
        college: collegeView(college),
    };
};

// ── Single account ──────────────────────────────────────────────────────────

const findScoped = async ({ actor, kind, id, collegeId }) => {
    if (!isObjectId(String(id ?? ""))) throw notFound(kind);
    const college = await resolveActorCollege(actor, collegeId, { purpose: "read" });
    const user = await User.findOne({ _id: String(id), ...scopeFilter(kind, college) });
    if (!user) throw notFound(kind);
    return user;
};

const populatedDTO = async (kind, user) => {
    await user.populate(POPULATE);
    if (kind !== "teacher") return toDTO(kind, user);
    const counts = await courseCounts([user._id]);
    return toFacultyDTO(user, counts ? (counts.get(String(user._id)) ?? 0) : undefined);
};

export const getProvisioned = async ({ actor, kind, id, collegeId }) => {
    const user = await findScoped({ actor, kind, id, collegeId });
    return populatedDTO(kind, user);
};

// ── Delivery and notifications ──────────────────────────────────────────────

const deliverTemporaryPassword = async ({ user, temporaryPassword, inviter, college, kind, sendEmail }) => {
    let configured = false;
    try {
        configured = Boolean(accountMailer.isConfigured());
    } catch {
        configured = false;
    }
    if (sendEmail !== false && configured) {
        const result = await sendInviteEmail({ user, temporaryPassword, inviter, college, kind: kindOf(kind).mailKind });
        if (result.delivered) return { delivery: "email" };
        return { delivery: "manual", temporaryPassword, emailError: "Could not send the invite email" };
    }
    return { delivery: "manual", temporaryPassword };
};

const notifyWelcome = async ({ user, inviter, college, kind }) => {
    try {
        const inviterName = inviter?.name || "Your placement office";
        if (kind === "teacher") {
            await notify(user._id, {
                type: "system",
                title: `Welcome to ${APP_NAME}`,
                body: `${inviterName} added you as faculty${user.department ? ` in ${user.department}` : ""}. `
                    + "Create a course to start taking attendance.",
                ui: { panel: "teacher.schedule" },
                priority: "normal",
            });
        } else {
            await notify(user._id, {
                type: "system",
                title: `Welcome to ${APP_NAME}`,
                body: `${inviterName} invited you to recruit at ${college?.name || college?.domain || "the college"}. `
                    + "Post a drive to reach students.",
                ui: { panel: "company.drives" },
                priority: "normal",
            });
        }
    } catch (error) {
        logAuthEvent("faculty", "welcome notification failed", { userId: String(user._id), error: error?.message || String(error) }, "warn");
    }
};

const temporaryExpiry = (now = new Date()) => new Date(now.getTime() + TEMP_PASSWORD_TTL_DAYS * DAY_MS);

// ── Create / update / deactivate / reset ────────────────────────────────────

/**
 * Validate an invite without side effects (copilot previews). Throws the
 * same errors as inviteUser. Returns the normalised args, college and company.
 */
export const previewInvite = async ({ actor, kind, input, collegeId }) => {
    const args = validateInviteInput(kind, input);
    const college = await resolveActorCollege(actor, collegeId, { purpose: "create" });
    await assertEmailAvailable(args.email);
    const company = kind === "company" ? await resolveCompany(args, { create: false }) : null;
    return { args, college: collegeView(college), company };
};

/**
 * Create a teacher or recruiter with a temporary password.
 * @returns {Promise<{user: object, delivery: "email"|"manual", temporaryPassword?: string, emailError?: string, company?: object}>}
 */
export const inviteUser = async ({ actor, kind, input, sendEmail = true, collegeId }) => {
    const spec = kindOf(kind);
    const args = validateInviteInput(kind, input);
    const college = await resolveActorCollege(actor, collegeId, { purpose: "create" });
    await assertEmailAvailable(args.email);
    const company = kind === "company" ? await resolveCompany(args, { create: true }) : null;

    const temporaryPassword = generateTemporaryPassword();
    const now = new Date();
    let user;
    try {
        user = await User.create({
            name: args.name,
            email: args.email,
            password: temporaryPassword,
            role: spec.role,
            authProvider: "local",
            college: college._id,
            collegeName: college.name,
            ...(kind === "teacher"
                ? { department: args.department, designation: args.designation, employeeId: args.employeeId }
                : { designation: args.designation, company: company._id }),
            mustChangePassword: true,
            tempPasswordExpiresAt: temporaryExpiry(now),
            invitedBy: actor._id,
            invitedAt: now,
        });
    } catch (error) {
        if (error?.code === 11000) {
            throw fail(409, "An account with this email already exists.", "EMAIL_EXISTS", { existingRole: null, existingActive: null });
        }
        throw error;
    }

    const delivery = await deliverTemporaryPassword({ user, temporaryPassword, inviter: actor, college, kind, sendEmail });
    await notifyWelcome({ user, inviter: actor, college, kind });
    logAuthEvent("faculty", `invited ${spec.role}`, { userId: String(user._id), by: String(actor._id), delivery: delivery.delivery });

    const result = { user: await populatedDTO(kind, user), ...delivery };
    if (company) result.company = { _id: company._id, name: company.name };
    return result;
};

const PATCH_KEYS = {
    teacher: ["name", "department", "designation", "employeeId", "isActive"],
    company: ["name", "designation", "companyId", "companyName", "isActive"],
};

/** Deactivate in memory + revoke access (caller saves first). */
const applyDeactivation = (user, actor, now = new Date()) => {
    user.isActive = false;
    user.deactivatedAt = now;
    user.deactivatedBy = actor._id;
    user.passwordResetToken = undefined;
    user.passwordResetExpiry = undefined;
};

const applyReactivation = (user) => {
    user.isActive = true;
    user.deactivatedAt = undefined;
    user.deactivatedBy = undefined;
};

export const updateProvisioned = async ({ actor, kind, id, patch = {}, collegeId }) => {
    const body = patch && typeof patch === "object" ? patch : {};
    if (body.email !== undefined || body.role !== undefined) {
        throw fail(400, "email and role cannot be changed", "VALIDATION", { field: body.email !== undefined ? "email" : "role" });
    }
    const keys = PATCH_KEYS[kind].filter((key) => body[key] !== undefined);
    if (keys.length === 0) throw fail(400, "Nothing to update", "VALIDATION");
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
        throw validation("isActive", "isActive must be true or false");
    }

    // Validate everything before loading/changing anything.
    const changes = {};
    if (body.name !== undefined) changes.name = requiredName(body.name);
    if (body.designation !== undefined) changes.designation = optionalText(body.designation, "designation", 80, "Designation");
    if (kind === "teacher") {
        if (body.department !== undefined) changes.department = departmentValue(body.department);
        if (body.employeeId !== undefined) changes.employeeId = optionalText(body.employeeId, "employeeId", 40, "Employee ID");
    }
    let companyInput = null;
    if (kind === "company" && (body.companyId !== undefined || body.companyName !== undefined)) {
        companyInput = companyRef(body);
        if (!companyInput) throw validation("companyName", "Give exactly one of companyName or companyId");
    }

    const user = await findScoped({ actor, kind, id, collegeId });
    for (const [field, value] of Object.entries(changes)) {
        user[field] = value === "" ? undefined : value;
    }
    if (companyInput) {
        const company = await resolveCompany(companyInput, { create: true });
        user.company = company._id;
    }

    let deactivated = false;
    if (body.isActive === false && user.isActive !== false) {
        applyDeactivation(user, actor);
        deactivated = true;
    } else if (body.isActive === true && user.isActive === false) {
        applyReactivation(user);
    }
    await user.save({ validateBeforeSave: false });
    if (deactivated) {
        await invalidateUserAccess(user._id, "deactivated");
        logAuthEvent("faculty", `deactivated ${kindOf(kind).role}`, { userId: String(user._id), by: String(actor._id) });
    }
    return populatedDTO(kind, user);
};

/** Idempotent: an already inactive account is returned unchanged. */
export const deactivateProvisioned = async ({ actor, kind, id, collegeId }) => {
    const user = await findScoped({ actor, kind, id, collegeId });
    if (user.isActive === false) return populatedDTO(kind, user);
    applyDeactivation(user, actor);
    await user.save({ validateBeforeSave: false });
    await invalidateUserAccess(user._id, "deactivated");
    logAuthEvent("faculty", `deactivated ${kindOf(kind).role}`, { userId: String(user._id), by: String(actor._id) });
    return populatedDTO(kind, user);
};

/** New temporary password (mustChangePassword) + revoke all access. 409 ACCOUNT_INACTIVE for inactive users. */
export const resetProvisionedPassword = async ({ actor, kind, id, sendEmail = true, collegeId }) => {
    const user = await findScoped({ actor, kind, id, collegeId });
    if (user.isActive === false) throw fail(409, "Reactivate the account first", "ACCOUNT_INACTIVE");

    const temporaryPassword = generateTemporaryPassword();
    user.password = temporaryPassword;
    user.mustChangePassword = true;
    user.tempPasswordExpiresAt = temporaryExpiry();
    user.passwordResetToken = undefined;
    user.passwordResetExpiry = undefined;
    await user.save({ validateBeforeSave: false });
    await invalidateUserAccess(user._id, "admin_reset");

    const dto = await populatedDTO(kind, user);
    const college = dto.college || (user.college ? await College.findById(user.college).select("name domain").lean() : null);
    const delivery = await deliverTemporaryPassword({ user, temporaryPassword, inviter: actor, college, kind, sendEmail });
    logAuthEvent("faculty", `password reset for ${kindOf(kind).role}`, { userId: String(user._id), by: String(actor._id), delivery: delivery.delivery });
    return { user: dto, ...delivery };
};

// ── Colleges (§8) ───────────────────────────────────────────────────────────

export const toCollegeDTO = (college) => ({
    _id: college._id,
    name: college.name || college.domain,
    domain: college.domain,
    branches: Array.isArray(college.branches) ? college.branches : [],
    departments: Array.isArray(college.departments) ? college.departments : [],
    tpo: refView(college.tpo, ["name", "email"]),
});
