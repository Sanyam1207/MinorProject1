// Common copilot tools available to every role (AGENT-TOOLS.md §4):
//   open_panel      switch the right-hand workspace to one of the caller's panels
//   get_my_profile  the signed-in user's own profile summary
// (notifications_list / notifications_mark_read live in the notifications module.)
//
// Other modules' models are never imported here: optional counts look them up
// through mongoose.models and are skipped when a model is not registered.
import mongoose from "mongoose";
import { fail } from "../../core/http.js";
import { ALL_ROLES, ROLE_LABELS } from "./constants.js";
import { warnOnce } from "./log.js";
import { PANEL_TITLES, panelsForRole } from "./panels.js";
import { isPlainObject } from "./validate.js";

const clip = (value, max) => {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// ── open_panel ──────────────────────────────────────────────────────────────

// Canonical panel param names (UI-ACTIONS.md §1/§5). Declared so the LLM can
// fill them; other keys are passed through and the frontend drops whatever the
// target panel does not declare.
const PANEL_PARAMS = {
    courseId: { type: "string", description: "Course id from an earlier tool result" },
    sessionId: { type: "string", description: "Class session id" },
    jobId: { type: "string", description: "Campus drive or job id" },
    applicationId: { type: "string", description: "Application id" },
    offerId: { type: "string", description: "Offer id" },
    programId: { type: "string", description: "Training program id" },
    resumeId: { type: "string", description: "Resume id" },
    credentialId: { type: "string", description: "Saved AI key id" },
    source: { type: "string", description: "Job source: 'campus' or 'market' for job details, else a job-feed source" },
    jobSource: { type: "string", description: "'campus' or 'market'" },
    status: { type: "string", description: "Status filter" },
    query: { type: "string", description: "Search text" },
    category: { type: "string", description: "Job category" },
    jobType: { type: "string", description: "full-time, part-time, internship or contract" },
    tab: { type: "string", description: "Tab inside the panel" },
    date: { type: "string", description: "Day to show, YYYY-MM-DD" },
    days: { type: "integer", description: "How many days of the schedule to show (1-31)" },
    threshold: { type: "number", description: "Attendance threshold percentage (0-100)" },
};

const PARAM_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_PARAMS = 20;
const MAX_PARAM_TEXT = 2000;
const MAX_PARAM_LIST = 20;

const scalarParam = (value) => {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed.slice(0, MAX_PARAM_TEXT) : undefined;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value;
    return undefined;
};

/** Small, JSON-safe panel params: scalars and short lists of strings/numbers only. */
const sanitizePanelParams = (params) => {
    if (!isPlainObject(params)) return {};
    const out = {};
    for (const [key, value] of Object.entries(params)) {
        if (Object.keys(out).length >= MAX_PARAMS) break;
        if (!PARAM_KEY_RE.test(key)) continue;
        if (Array.isArray(value)) {
            const items = value.map(scalarParam).filter((item) => item !== undefined && typeof item !== "boolean").slice(0, MAX_PARAM_LIST);
            if (items.length) out[key] = items;
            continue;
        }
        const scalar = scalarParam(value);
        if (scalar !== undefined) out[key] = scalar;
    }
    return out;
};

const panelDescription = (panels) => clip(
    `Panel to open. Options: ${panels.map((id) => `${id} (${PANEL_TITLES[id] || id})`).join("; ")}.`,
    1000,
);

export const openPanelTool = {
    name: "open_panel",
    description: "Open a screen in the user's right-hand workspace, next to the chat — e.g. when the user says "
        + "'open my attendance', 'show my schedule' or 'go to offers'. Tools that fetch data (attendance, jobs, "
        + "applications, offers, resumes, notifications…) already open their own panel, so use this only when no "
        + "other tool fits. `params` optionally pre-selects an item or filter, using ids from earlier tool results.",
    roles: [...ALL_ROLES],
    confirm: false,
    parameters: (ctx) => {
        const panels = panelsForRole(ctx?.role);
        return {
            type: "object",
            properties: {
                panel: { type: "string", enum: [...panels], description: panelDescription(panels) },
                params: {
                    type: "object",
                    description: "Optional panel parameters (canonical names only), e.g. {\"courseId\": \"…\"}",
                    properties: PANEL_PARAMS,
                    additionalProperties: true,
                },
            },
            required: ["panel"],
        };
    },
    handler: async (args, ctx) => {
        const { panel } = args;
        // The enum already restricts `panel`; re-checked here as defence in depth.
        if (!panelsForRole(ctx.role).includes(panel)) {
            throw fail(403, `The ${panel} panel is not available to a ${ROLE_LABELS[ctx.role] || ctx.role}.`, "FORBIDDEN");
        }
        const params = sanitizePanelParams(args.params);
        const title = PANEL_TITLES[panel] || panel;
        return {
            summary: `Opened ${title}.`,
            data: { panel, title, params },
            ui: { panel, params },
        };
    },
};

// ── get_my_profile ──────────────────────────────────────────────────────────

const STUDENT_FIELDS = ["branch", "section", "semester", "passingYear", "rollNumber", "cgpa", "skills", "ggsipuLinked"];
const ALUMNI_FIELDS = ["branch", "passingYear", "skills"];
const STAFF_FIELDS = ["department", "designation", "employeeId"];
const FIELDS_BY_ROLE = {
    student: STUDENT_FIELDS,
    alumni: ALUMNI_FIELDS,
    teacher: STAFF_FIELDS,
    tpo: STAFF_FIELDS,
    admin: STAFF_FIELDS,
    company: ["designation"],
};

const plainValue = (value) => {
    if (value === undefined || value === null || value === "") return null;
    if (Array.isArray(value)) return Array.from(value, (item) => String(item));
    return value;
};

const resolveCollege = async (user) => {
    const College = mongoose.models.College;
    if (College) {
        const domain = typeof user.email === "string" ? user.email.split("@")[1]?.toLowerCase() : null;
        const query = user.college ? { _id: user.college } : domain ? { domain } : null;
        if (query) {
            const college = await College.findOne(query).select("name domain").lean();
            if (college) {
                return { id: String(college._id), name: college.name || college.domain || null, domain: college.domain || null };
            }
        }
    }
    return user.collegeName ? { id: null, name: user.collegeName, domain: null } : null;
};

const resolveCompany = async (user) => {
    if (!user.company) return null;
    const Company = mongoose.models.Company;
    const company = Company ? await Company.findById(user.company).select("name").lean() : null;
    return { id: String(user.company), name: company?.name ?? null };
};

/** Same shape as AUTH-FACULTY.md §6.4 toProfileSummary(); used until/unless that service exists. */
const builtInProfileSummary = async (user, role) => {
    const profile = {
        id: String(user._id),
        name: user.name ?? null,
        email: user.email ?? null,
        role,
        college: await resolveCollege(user),
    };
    for (const field of FIELDS_BY_ROLE[role] ?? []) profile[field] = plainValue(user[field]);
    if (Object.hasOwn(profile, "skills") && profile.skills === null) profile.skills = [];
    if (role === "company") profile.company = await resolveCompany(user);
    return profile;
};

// AUTH-FACULTY.md §6.4: the identity part comes from toProfileSummary() in
// services/user-profile.service.js (owned by auth-faculty). Loaded lazily and
// optional, so this tool also works before (or without) that service.
let profileServicePromise = null;
const loadProfileSummarizer = () => {
    profileServicePromise ||= import("../../services/user-profile.service.js")
        .then((service) => (typeof service.toProfileSummary === "function" ? service.toProfileSummary : null))
        .catch((error) => {
            const missing = error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("user-profile.service");
            if (!missing) warnOnce("profile-service", `services/user-profile.service.js could not be loaded; using the built-in profile summary (${error?.message || error})`);
            return null;
        });
    return profileServicePromise;
};

const optional = async (label, compute) => {
    try {
        return await compute();
    } catch (error) {
        warnOnce(`profile:${label}`, `get_my_profile could not compute the ${label}: ${error?.message || error}`);
        return undefined;
    }
};

const countActiveResumes = async (user) => {
    const Resume = mongoose.models.Resume;
    if (!Resume) return undefined;
    return Resume.countDocuments({ owner: user._id, status: "active" });
};

// ATTENDANCE.md "Percentages": attended = present + late over ended sessions,
// excused removed from the denominator, null when nothing counts yet. Every
// enrolled student has a record for each ended session (absent ones are filled
// in when the session is finalised).
const attendanceOverall = async (user) => {
    const Record = mongoose.models.AttendanceRecord;
    const Session = mongoose.models.ClassSession;
    if (!Record || !Session) return undefined;
    const [row] = await Record.aggregate([
        { $match: { student: user._id } },
        { $lookup: { from: Session.collection.collectionName, localField: "session", foreignField: "_id", as: "classSession" } },
        { $match: { "classSession.status": "ended" } },
        {
            $group: {
                _id: null,
                held: { $sum: 1 },
                attended: { $sum: { $cond: [{ $in: ["$status", ["present", "late"]] }, 1, 0] } },
                excused: { $sum: { $cond: [{ $eq: ["$status", "excused"] }, 1, 0] } },
            },
        },
    ]);
    if (!row) return { attended: 0, held: 0, percent: null };
    const countable = row.held - row.excused;
    return {
        attended: row.attended,
        held: row.held,
        percent: countable > 0 ? Math.round((row.attended / countable) * 1000) / 10 : null,
    };
};

const buildProfile = async ({ user, role }) => {
    let identity = null;
    const summarize = await loadProfileSummarizer();
    if (summarize) {
        identity = await optional("profile summary", async () => {
            const summary = await summarize(user);
            return isPlainObject(summary) ? summary : undefined;
        });
    }
    const profile = { ...(identity ?? await builtInProfileSummary(user, role)) };
    if (role === "student") {
        const [resumeCount, attendance] = await Promise.all([
            optional("resume count", () => countActiveResumes(user)),
            optional("overall attendance", () => attendanceOverall(user)),
        ]);
        if (resumeCount !== undefined) profile.resumeCount = resumeCount;
        if (attendance !== undefined) profile.attendance = attendance;
    }
    return profile;
};

const describeProfile = (profile, role) => {
    const roleLabel = ROLE_LABELS[role] || role || "user";
    const organisation = role === "company" ? profile.company?.name : profile.college?.name;
    const sentences = [`${profile.name || "You"} — ${roleLabel}${organisation ? ` at ${organisation}` : ""}.`];

    if (role === "student" || role === "alumni") {
        const academic = [
            profile.branch,
            role === "student" && profile.section ? `section ${profile.section}` : null,
            role === "student" && profile.semester ? `semester ${profile.semester}` : null,
            profile.passingYear ? `class of ${profile.passingYear}` : null,
        ].filter(Boolean);
        if (academic.length) sentences.push(`${academic.join(", ")}.`);
    }
    if (role === "student") {
        sentences.push(typeof profile.cgpa === "number" ? `CGPA ${profile.cgpa}.` : "CGPA not on record.");
    }
    if (Array.isArray(profile.skills) && profile.skills.length) {
        const shown = profile.skills.slice(0, 8).join(", ");
        const more = profile.skills.length > 8 ? ` (+${profile.skills.length - 8} more)` : "";
        sentences.push(`Skills: ${shown}${more}.`);
    }
    if (["teacher", "tpo", "admin", "company"].includes(role)) {
        const staff = [profile.department ? `${profile.department} department` : null, profile.designation].filter(Boolean);
        if (staff.length) sentences.push(`${staff.join(", ")}.`);
    }
    if (typeof profile.resumeCount === "number") {
        sentences.push(`${profile.resumeCount} active resume${profile.resumeCount === 1 ? "" : "s"} in Resume Lab.`);
    }
    if (profile.attendance) {
        const { attended, held, percent } = profile.attendance;
        sentences.push(typeof percent === "number"
            ? `Attendance ${percent}% overall (${attended} attended of ${held} classes held).`
            : "No attendance recorded yet.");
    }
    return clip(sentences.join(" "), 600);
};

export const getMyProfileTool = {
    name: "get_my_profile",
    description: "Get the signed-in user's own profile: name, role and college; for students also branch, section, "
        + "semester, graduation year, CGPA, skills, number of resumes and overall attendance; for faculty and staff "
        + "department and designation. Use it for questions like 'what is my CGPA?' or 'what does my profile say?'. Read-only.",
    roles: [...ALL_ROLES],
    confirm: false,
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
        const profile = await buildProfile(ctx);
        return { summary: describeProfile(profile, ctx.role), data: { profile } };
    },
};

export default [openPanelTool, getMyProfileTool];
