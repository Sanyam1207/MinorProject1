// Copilot tools of the faculty module (docs/contracts/AUTH-FACULTY.md §10.1,
// AGENT-TOOLS.md §2/§5): faculty_list, faculty_invite (catalogue) and the
// AUTH-FACULTY extensions recruiters_list, recruiter_invite.
//
// No tool summary, data, ui or preview ever contains a temporary password:
// manual-delivery passwords go to the one-time reveal store and only the
// opaque `revealId` travels (to the TPO's panel, which redeems it once).
import { fail } from "../../core/http.js";
import { accountMailer } from "../../services/account-mail.service.js";
import {
    inviteUser,
    listProvisioned,
    previewInvite,
    summarizeProvisioned,
} from "./provisioning.service.js";
import { putReveal } from "./reveal-store.js";

const ROLES = ["tpo", "admin"];
const STATUS_ENUM = ["active", "inactive", "all"];

const mailerConfigured = () => {
    try {
        return Boolean(accountMailer.isConfigured());
    } catch {
        return false;
    }
};

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const clampLimit = (value) => Math.min(50, Math.max(1, Number.isInteger(value) ? value : 20));

/** Copilot rule: an admin without a college must use the panel (which can pick one). */
const assertToolCollege = (ctx) => {
    if (ctx?.role === "admin" && !ctx.user?.college) {
        throw fail(400, "Link your account to a college or use the Faculty panel", "COLLEGE_REQUIRED");
    }
};

const scopeLabel = (college) => (college ? `at ${college.name}` : "across all colleges");

const groupsText = (groups) => {
    const shown = groups.slice(0, 6).map((group) => `${group.label} ${group.count}`);
    const rest = groups.slice(6).reduce((sum, group) => sum + group.count, 0);
    if (rest) shown.push(`others ${rest}`);
    return shown.join(", ");
};

const compactParams = (params) => Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
);

// ── faculty_list / recruiters_list ──────────────────────────────────────────

const listTool = ({ name, kind, noun, panel, description, extraProperties }) => ({
    name,
    description,
    roles: ROLES,
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            search: { type: "string", description: "Part of a name or email" },
            ...extraProperties,
            status: { type: "string", enum: STATUS_ENUM, description: "Default active" },
            limit: { type: "integer", description: "How many to return (default 20, max 50)" },
        },
    },
    handler: async (args, ctx) => {
        const query = {
            search: text(args.search),
            department: text(args.department),
            company: text(args.company),
            status: args.status || "active",
            limit: clampLimit(args.limit),
            page: 1,
        };
        const [list, stats] = await Promise.all([
            listProvisioned({ actor: ctx.user, kind, query }),
            summarizeProvisioned({ actor: ctx.user, kind, query: { ...query, status: "all" } }),
        ]);
        const items = list.items.map((item) => ({
            id: String(item._id),
            name: item.name,
            email: item.email,
            ...(kind === "teacher"
                ? { department: item.department, designation: item.designation, courseCount: item.courseCount ?? null }
                : { company: item.company?.name ?? null, designation: item.designation }),
            isActive: item.isActive,
        }));

        let summary;
        if (stats.total === 0) {
            summary = `No ${noun} ${scopeLabel(stats.college)} match.`;
        } else {
            const grouped = groupsText(stats.groups);
            summary = `${stats.total} ${noun} ${scopeLabel(stats.college)} (${stats.active} active)${grouped ? `: ${grouped}` : ""}.`;
            if (query.status !== "all") summary += ` Showing ${items.length} ${query.status} of ${list.total}.`;
        }
        return {
            summary,
            data: { items, total: list.total },
            ui: {
                panel,
                params: compactParams({
                    query: query.search,
                    search: query.search,
                    department: query.department,
                    company: query.company,
                    status: query.status,
                }),
            },
        };
    },
});

// ── faculty_invite / recruiter_invite ───────────────────────────────────────

const toolInput = (kind, args) => (kind === "teacher"
    ? { name: args.name, email: args.email, department: args.department, designation: args.designation }
    : { name: args.name, email: args.email, companyName: args.company, designation: args.designation });

const inviteTool = ({ name, kind, panel, description, properties, required, describe }) => ({
    name,
    description,
    roles: ROLES,
    confirm: true,
    parameters: { type: "object", properties, required },
    preview: async (args, ctx) => {
        assertToolCollege(ctx);
        const { args: normalised, company } = await previewInvite({ actor: ctx.user, kind, input: toolInput(kind, args) });
        const delivery = mailerConfigured()
            ? "Login details will be emailed."
            : `You will see a one-time temporary password in the ${kind === "teacher" ? "Faculty" : "Recruiters"} panel.`;
        const outArgs = kind === "teacher"
            ? compactParams({ name: normalised.name, email: normalised.email, department: normalised.department, designation: normalised.designation })
            : compactParams({ name: normalised.name, email: normalised.email, company: company?.name || normalised.companyName, designation: normalised.designation });
        return {
            summary: `Invite **${normalised.name}** (${normalised.email}) as ${describe(outArgs, company)}? ${delivery}`,
            args: outArgs,
        };
    },
    handler: async (args, ctx) => {
        assertToolCollege(ctx);
        const result = await inviteUser({ actor: ctx.user, kind, input: toolInput(kind, args), sendEmail: true });
        const { user } = result;
        const id = String(user._id);
        let revealId;
        if (result.delivery === "manual" && result.temporaryPassword) {
            revealId = putReveal({ ownerId: ctx.user._id, email: user.email, password: result.temporaryPassword });
        }
        const what = describe({ department: user.department, company: result.company?.name }, result.company);
        const panelName = kind === "teacher" ? "Faculty" : "Recruiters";
        const summary = result.delivery === "email"
            ? `Invited ${user.name} as ${what}. Login details were emailed to ${user.email}.`
            : `Invited ${user.name} as ${what}. Open the ${panelName} panel to copy the one-time temporary password (valid 10 minutes).`;
        const params = kind === "teacher"
            ? compactParams({ highlightId: id, facultyId: id, revealId })
            : compactParams({ highlightId: id, recruiterId: id, revealId, revealInviteId: revealId });
        const data = kind === "teacher"
            ? { faculty: { id, name: user.name, email: user.email, department: user.department ?? null }, delivery: result.delivery }
            : {
                recruiter: { id, name: user.name, email: user.email, company: result.company?.name ?? null },
                delivery: result.delivery,
            };
        // Built field by field: the result never includes `temporaryPassword`.
        return { summary, data, ui: { panel, params } };
    },
});

export default [
    listTool({
        name: "faculty_list",
        kind: "teacher",
        noun: "faculty",
        panel: "tpo.faculty",
        description: "List the faculty (teacher) accounts of the placement office's college, with department, designation, "
            + "status and active course count — e.g. 'how many teachers do we have in CSE?'. Read-only; opens the Faculty panel.",
        extraProperties: {
            department: { type: "string", description: "Department, e.g. 'CSE' or 'computer science'" },
        },
    }),
    inviteTool({
        name: "faculty_invite",
        kind: "teacher",
        panel: "tpo.faculty",
        description: "Create a faculty (teacher) account for the college and send the login details. The teacher must "
            + "change the temporary password at first sign-in. Ask for the name and email if they are missing.",
        properties: {
            name: { type: "string", description: "Full name, e.g. 'Dr. Anita Sharma'" },
            email: { type: "string", description: "The teacher's email address" },
            department: { type: "string", description: "Department, e.g. 'CSE'" },
            designation: { type: "string", description: "e.g. 'Assistant Professor'" },
        },
        required: ["name", "email"],
        describe: (args) => (args.department ? `${args.department} faculty` : "faculty"),
    }),
    listTool({
        name: "recruiters_list",
        kind: "company",
        noun: "recruiters",
        panel: "tpo.recruiters",
        description: "List the recruiter accounts invited by the placement office, with their company and status. "
            + "Read-only; opens the Recruiters panel.",
        extraProperties: {
            company: { type: "string", description: "Company name (or part of it)" },
        },
    }),
    inviteTool({
        name: "recruiter_invite",
        kind: "company",
        panel: "tpo.recruiters",
        description: "Create a recruiter account for a company so they can post drives and review applicants at this "
            + "college. The recruiter must change the temporary password at first sign-in.",
        properties: {
            name: { type: "string", description: "Recruiter's full name" },
            email: { type: "string", description: "Recruiter's email address" },
            company: { type: "string", description: "Company name, e.g. 'Acme Corp'" },
            designation: { type: "string", description: "e.g. 'Talent Acquisition Lead'" },
        },
        required: ["name", "email", "company"],
        describe: (args, company) => `a recruiter for ${company?.name || args.company || "the company"}`,
    }),
];
