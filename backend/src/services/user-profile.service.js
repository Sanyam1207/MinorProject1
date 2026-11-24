// Self-service profile rules and the identity summary used by the copilot
// (docs/contracts/AUTH-FACULTY.md §6, PLACEMENTS.md §3.7).
//
//   buildProfileUpdate(user, body) → { set, unset, ignored: [{field, reason}] }
//     Throws 400 VALIDATION {field} for an invalid value of an editable field.
//     Unknown or role-disallowed keys are ignored; GGSIPU-locked cgpa/branch
//     changes are ignored (not rejected) and reported with reason "ggsipu_locked".
//   toProfileSummary(user) → plain object (identity part of get_my_profile).
import mongoose from "mongoose";
import { fail } from "../core/http.js";
import { canonicalBranch } from "../utils/branch.js";

export const PROFILE_LOCK_MESSAGE = "Profile updated. CGPA and branch are synced from GGSIPU and were not changed.";
export const PROFILE_EMPTY_MESSAGE = "Please provide at least one field to update";

const STUDENT = ["student"];
const ALL = ["student", "teacher", "tpo", "admin", "company", "alumni"];

/** Which roles may self-edit each field (§6.1 + PLACEMENTS §3.7). */
export const PROFILE_FIELD_ROLES = Object.freeze({
    name: ALL,
    profile: ALL,
    socialLinks: ["student", "teacher", "alumni"],
    branch: STUDENT,
    cgpa: STUDENT,
    passingYear: STUDENT,
    collegeName: STUDENT,
    skills: ["student", "alumni"],
    projects: STUDENT,
    certifications: STUDENT,
    experience: STUDENT,
    careerPreferences: STUDENT,
    activeBacklogs: STUDENT,
    tenthPercentage: STUDENT,
    twelfthPercentage: STUDENT,
    department: ["teacher"],
    designation: ["teacher", "tpo", "admin", "company"],
});

const SOCIAL_KEYS = ["github", "linkedin", "leetcode", "portfolio"];

export const isAcademicLocked = (user) => user?.role === "student" && user?.ggsipuLinked === true;

const invalid = (field, message) => fail(400, message, "VALIDATION", { field });
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

const boundedString = (value, field, max, { min = 0, label = field } = {}) => {
    if (value === null || value === undefined) return "";
    if (typeof value !== "string" && typeof value !== "number") throw invalid(field, `${label} must be text`);
    const text = String(value).trim();
    if (text.length < min || text.length > max) {
        throw invalid(field, min > 0 ? `${label} must be ${min}–${max} characters` : `${label} must be at most ${max} characters`);
    }
    return text;
};

const stringList = (value, field, { maxItems, maxLength, label = field }) => {
    let list = value;
    if (typeof list === "string") list = list.split(",");
    if (list === null || list === undefined) list = [];
    if (!Array.isArray(list)) throw invalid(field, `${label} must be a list`);
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        if (entry === null || entry === undefined) continue;
        if (typeof entry !== "string" && typeof entry !== "number") throw invalid(field, `${label} must contain text only`);
        const text = String(entry).trim();
        if (!text) continue;
        if (text.length > maxLength) throw invalid(field, `Each ${label} entry must be at most ${maxLength} characters`);
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    if (out.length > maxItems) throw invalid(field, `${label} can have at most ${maxItems} entries`);
    return out;
};

const objectList = (value, field, { maxItems, fields, label = field }) => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) throw invalid(field, `${label} must be a list`);
    if (value.length > maxItems) throw invalid(field, `${label} can have at most ${maxItems} entries`);
    return value.map((item) => {
        if (!isPlainObject(item)) throw invalid(field, `Each ${label} entry must be an object`);
        const out = {};
        for (const [key, spec] of Object.entries(fields)) {
            if (spec.list) {
                out[key] = stringList(item[key], field, { maxItems: spec.list, maxLength: spec.max, label: `${label} ${key}` });
            } else {
                out[key] = boundedString(item[key], field, spec.max, { label: `${label} ${key}` });
            }
        }
        return out;
    });
};

const optionalNumber = (value, field, { min, max, integer = false, label }) => {
    if (isBlank(value)) return null;
    const number = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max
        || (integer && !Number.isInteger(number))) {
        throw invalid(field, `${label} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
    }
    return number;
};

const httpUrl = (value, field, max) => {
    const text = boundedString(value, field, max, { label: "Profile picture URL" });
    if (!text) return "";
    let url;
    try {
        url = new URL(text);
    } catch {
        throw invalid(field, "Profile picture must be an http(s) URL");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw invalid(field, "Profile picture must be an http(s) URL");
    return text;
};

const roundCgpa = (value) => Math.round(value * 100) / 100;

/**
 * Validate a PATCH /auth/me body for `user`.
 * @returns {{ set: object, unset: object, ignored: Array<{field: string, reason: string}> }}
 */
export const buildProfileUpdate = (user, body) => {
    const input = isPlainObject(body) ? body : {};
    const role = user?.role || "student";
    const locked = isAcademicLocked(user);
    const set = {};
    const unset = {};
    const ignored = [];
    const assign = (field, value) => {
        if (value === null) unset[field] = 1;
        else set[field] = value;
    };

    for (const [field, value] of Object.entries(input)) {
        if (value === undefined) continue;
        const roles = PROFILE_FIELD_ROLES[field];
        if (!roles) continue; // unknown or never-editable key (email, role, isActive, …): silently ignored
        if (!roles.includes(role)) {
            ignored.push({ field, reason: "not_editable_for_role" });
            continue;
        }

        switch (field) {
            case "name":
                set.name = boundedString(value, field, 80, { min: 2, label: "Name" });
                break;
            case "profile":
                set.profile = httpUrl(value, field, 500);
                break;
            case "socialLinks": {
                if (!isPlainObject(value)) throw invalid(field, "socialLinks must be an object");
                const stored = isPlainObject(user.socialLinks) ? user.socialLinks : {};
                const merged = {};
                for (const key of SOCIAL_KEYS) merged[key] = typeof stored[key] === "string" ? stored[key] : "";
                for (const key of SOCIAL_KEYS) {
                    if (value[key] !== undefined) merged[key] = boundedString(value[key], field, 300, { label: `${key} link` });
                }
                set.socialLinks = merged;
                break;
            }
            case "branch": {
                const text = boundedString(value, field, 60, { label: "Branch" });
                const branch = text ? canonicalBranch(text) : "";
                if (locked) {
                    const stored = user.branch ? canonicalBranch(user.branch) : "";
                    if (branch !== stored) ignored.push({ field, reason: "ggsipu_locked" });
                    break;
                }
                if (branch) set.branch = branch;
                else unset.branch = 1;
                break;
            }
            case "cgpa": {
                const number = optionalNumber(value, field, { min: 0, max: 10, label: "CGPA" });
                const cgpa = number === null ? null : roundCgpa(number);
                if (locked) {
                    const stored = typeof user.cgpa === "number" ? roundCgpa(user.cgpa) : null;
                    if (cgpa !== stored) ignored.push({ field, reason: "ggsipu_locked" });
                    break;
                }
                assign("cgpa", cgpa);
                break;
            }
            case "passingYear": {
                if (isBlank(value)) {
                    unset.passingYear = 1;
                    break;
                }
                const year = String(value).trim();
                if (!/^20\d{2}$/.test(year)) throw invalid(field, "Passing year must look like 2027");
                set.passingYear = year;
                break;
            }
            case "collegeName":
                set.collegeName = boundedString(value, field, 120, { label: "College name" });
                break;
            case "skills":
                set.skills = stringList(value, field, { maxItems: 50, maxLength: 60, label: "skills" });
                break;
            case "projects":
                set.projects = objectList(value, field, {
                    maxItems: 20,
                    label: "projects",
                    fields: { title: { max: 120 }, description: { max: 1000 }, skills: { list: 20, max: 60 }, link: { max: 300 } },
                });
                break;
            case "certifications":
                set.certifications = objectList(value, field, {
                    maxItems: 30,
                    label: "certifications",
                    fields: { name: { max: 300 }, issuer: { max: 300 }, date: { max: 300 }, credentialUrl: { max: 300 } },
                });
                break;
            case "experience":
                set.experience = objectList(value, field, {
                    maxItems: 20,
                    label: "experience",
                    fields: { title: { max: 120 }, company: { max: 120 }, duration: { max: 120 }, description: { max: 1000 } },
                });
                break;
            case "careerPreferences": {
                if (!isPlainObject(value)) throw invalid(field, "careerPreferences must be an object");
                const stored = isPlainObject(user.careerPreferences) ? user.careerPreferences : {};
                set.careerPreferences = {
                    preferredRoles: value.preferredRoles !== undefined
                        ? stringList(value.preferredRoles, field, { maxItems: 10, maxLength: 120, label: "preferred roles" })
                        : (Array.isArray(stored.preferredRoles) ? stored.preferredRoles : []),
                    preferredLocations: value.preferredLocations !== undefined
                        ? stringList(value.preferredLocations, field, { maxItems: 10, maxLength: 120, label: "preferred locations" })
                        : (Array.isArray(stored.preferredLocations) ? stored.preferredLocations : []),
                    expectedSalary: value.expectedSalary !== undefined
                        ? boundedString(value.expectedSalary, field, 60, { label: "Expected salary" })
                        : (typeof stored.expectedSalary === "string" ? stored.expectedSalary : ""),
                };
                break;
            }
            case "activeBacklogs":
                assign(field, optionalNumber(value, field, { min: 0, max: 50, integer: true, label: "Active backlogs" }));
                break;
            case "tenthPercentage":
                assign(field, optionalNumber(value, field, { min: 0, max: 100, label: "10th percentage" }));
                break;
            case "twelfthPercentage":
                assign(field, optionalNumber(value, field, { min: 0, max: 100, label: "12th percentage" }));
                break;
            case "department": {
                const text = boundedString(value, field, 60, { label: "Department" });
                if (text) set.department = canonicalBranch(text);
                else unset.department = 1;
                break;
            }
            case "designation":
                set.designation = boundedString(value, field, 80, { label: "Designation" });
                break;
            default:
                break;
        }
    }

    return { set, unset, ignored };
};

/** True when `ignored` contains a GGSIPU-lock entry (drives the response message). */
export const hasLockedIgnores = (ignored) => Array.isArray(ignored) && ignored.some((entry) => entry.reason === "ggsipu_locked");

// ── Identity summary (AUTH-FACULTY §6.4) ─────────────────────────────────────

const STUDENT_KEYS = [
    "branch", "section", "semester", "passingYear", "rollNumber", "cgpa", "skills", "ggsipuLinked",
    "activeBacklogs", "tenthPercentage", "twelfthPercentage",
];
const KEYS_BY_ROLE = {
    student: STUDENT_KEYS,
    alumni: ["branch", "passingYear", "skills"],
    teacher: ["department", "designation", "employeeId"],
    tpo: ["department", "designation", "employeeId"],
    admin: ["department", "designation", "employeeId"],
    company: ["designation"],
};

const plain = (value) => {
    if (value === undefined || value === null || value === "") return null;
    if (Array.isArray(value)) return Array.from(value, (item) => String(item));
    if (value instanceof mongoose.Types.ObjectId) return String(value);
    return value;
};

const refId = (value) => {
    if (!value) return null;
    if (value instanceof mongoose.Types.ObjectId) return value;
    if (value._id) return value._id;
    return mongoose.isValidObjectId(value) ? value : null;
};

const summaryCollege = async (user) => {
    const College = mongoose.models.College;
    if (College) {
        const populated = user.college && typeof user.college === "object" && user.college.domain !== undefined ? user.college : null;
        let college = populated;
        const id = refId(user.college);
        if (!college && id) college = await College.findById(id).select("name domain").lean();
        if (!college) {
            const domain = typeof user.email === "string" ? user.email.split("@")[1]?.toLowerCase() : null;
            if (domain) college = await College.findOne({ domain }).select("name domain").lean();
        }
        if (college) return { id: String(college._id), name: college.name || college.domain || null, domain: college.domain || null };
    }
    return user.collegeName ? { id: null, name: user.collegeName, domain: null } : null;
};

const summaryCompany = async (user) => {
    const id = refId(user.company);
    if (!id) return null;
    if (typeof user.company === "object" && user.company.name !== undefined) return { id: String(id), name: user.company.name ?? null };
    const Company = mongoose.models.Company;
    const company = Company ? await Company.findById(id).select("name").lean() : null;
    return { id: String(id), name: company?.name ?? null };
};

/**
 * Identity summary of `user` (a mongoose doc or a plain object):
 * {id, name, email, role, college: {id, name, domain}|null, ...role keys, company?, mustChangePassword}.
 * Keys that do not apply to the role are omitted.
 */
export const toProfileSummary = async (user) => {
    if (!user) return null;
    const role = user.role || "student";
    const summary = {
        id: String(user._id),
        name: user.name ?? null,
        email: user.email ?? null,
        role,
        college: await summaryCollege(user),
    };
    for (const key of KEYS_BY_ROLE[role] ?? []) summary[key] = plain(user[key]);
    if (Object.hasOwn(summary, "skills") && summary.skills === null) summary.skills = [];
    if (Object.hasOwn(summary, "ggsipuLinked")) summary.ggsipuLinked = user.ggsipuLinked === true;
    if (role === "company") summary.company = await summaryCompany(user);
    summary.mustChangePassword = user.mustChangePassword === true;
    return summary;
};
