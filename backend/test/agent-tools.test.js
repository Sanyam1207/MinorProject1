// Tests for the agent-tools module (docs/contracts/AGENT-TOOLS.md §1–§4): tool-token
// authentication, manifest role filtering, argument validation and coercion, every
// /execute outcome (driven by fake tools), open_panel, get_my_profile and the audit trail.
import { connectTestDb, disconnectTestDb, createUser, authHeader, agentToolToken, getApp } from "./helpers.js";
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const suffix = () => crypto.randomBytes(4).toString("hex");

// docs/contracts/UI-ACTIONS.md §4, verbatim.
const TPO_PANELS = ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
    "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
    "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"];
const EXPECTED_PANELS = {
    student: ["student.home", "jobs.matched", "jobs.campus", "jobs.market", "jobs.tracker", "jobs.detail",
        "applications", "offers", "training", "calendar", "portfolio",
        "attendance.student", "attendance.scan", "schedule", "interview", "learning",
        "resume.home", "resume.lab", "settings.ai-keys", "alumni", "pr-outreach",
        "notifications", "profile", "report-issue"],
    teacher: ["teacher.home", "teacher.courses", "teacher.schedule", "teacher.live", "teacher.report",
        "teacher.analytics", "notifications", "profile", "report-issue"],
    tpo: TPO_PANELS,
    admin: TPO_PANELS,
    company: ["company.home", "company.drives", "company.applicants", "notifications", "profile", "report-issue"],
    alumni: ["alumni", "notifications", "profile", "report-issue"],
};

const ECHO_SCHEMA = {
    type: "object",
    properties: {
        text: { type: "string", description: "Any text" },
        count: { type: "integer", minimum: 1, maximum: 50 },
        ratio: { type: "number" },
        flag: { type: "boolean" },
        level: { type: "string", enum: ["low", "high"] },
        tags: { type: "array", items: { type: "string" } },
        audience: {
            type: "object",
            properties: { roles: { type: "array", items: { type: "string" } }, branch: { type: "string" } },
            required: ["roles"],
        },
        limit: { type: "integer", default: 8 },
        free: { type: "object" },
        note: { type: ["string", "null"] },
    },
    required: ["text"],
};

// Fake tools exercising every outcome of POST /execute. `calls` records handler runs.
const makeFakeTools = ({ fail, ApiError, calls }) => [
    {
        name: "zz_echo",
        description: "Echo the arguments back. Test helper.",
        roles: ["all"],
        parameters: ECHO_SCHEMA,
        handler: async (args, ctx) => ({
            summary: `echo ${args.text}`,
            data: {
                args,
                ctx: {
                    role: ctx.role,
                    userId: String(ctx.user._id),
                    requestId: ctx.requestId,
                    sessionId: ctx.sessionId,
                    nowIsDate: ctx.now instanceof Date,
                    timezone: ctx.timezone,
                    hasPassword: ctx.user.password !== undefined,
                },
            },
            ui: [{ panel: "profile", params: { tab: "x" } }, { nope: true }],
        }),
    },
    { name: "zz_student_only", description: "Student only.", roles: ["student"], handler: async () => ({ summary: "student ok" }) },
    {
        name: "zz_tpo_only",
        description: "TPO only.",
        roles: ["tpo"],
        handler: async (_args, ctx) => ({ summary: `tpo ok as ${ctx.role}`, ui: { panel: "tpo.home" } }),
    },
    { name: "zz_admin_only", description: "Admin only.", roles: ["admin"], handler: async () => ({ summary: "admin ok" }) },
    {
        name: "zz_schedule",
        description: "Schedule a test class for one of the teacher's courses. Needs confirmation.",
        roles: ["teacher"],
        confirm: true,
        parameters: {
            type: "object",
            properties: { course: { type: "string" }, when: { type: "string" }, durationMinutes: { type: "integer" } },
            required: ["course", "when"],
        },
        // Resolves the fuzzy course to an id, idempotently (like a real resolver).
        preview: async (args) => {
            const course = args.course.startsWith("id-") ? args.course : `id-${args.course.toLowerCase()}`;
            return {
                summary: `Schedule ${course.slice(3).toUpperCase()} at ${args.when}?`,
                args: { ...args, course, durationMinutes: args.durationMinutes ?? 60, junk: "dropped" },
            };
        },
        handler: async (args) => {
            calls.schedule.push(args);
            return { summary: `Scheduled ${args.course}.`, data: { args }, ui: { panel: "teacher.schedule", params: { sessionId: "s1" } } };
        },
    },
    {
        name: "zz_generic_confirm",
        description: "Withdraw a pretend application. This second sentence is not shown.",
        roles: ["student"],
        confirm: true,
        parameters: { type: "object", properties: { job: { type: "string" }, count: { type: "integer" } } },
        handler: async (args) => {
            calls.generic.push(args);
            return { summary: "withdrawn" };
        },
    },
    {
        name: "zz_preview_error",
        description: "Apply.",
        roles: ["student"],
        confirm: true,
        preview: async () => {
            throw fail(409, "You already applied to this drive", "ALREADY_APPLIED");
        },
        handler: async () => {
            calls.previewError.push(true);
            return { summary: "must not run" };
        },
    },
    {
        name: "zz_preview_ambiguous",
        description: "Apply.",
        roles: ["student"],
        confirm: true,
        parameters: { type: "object", properties: { job: { type: "string" } } },
        preview: async () => ({
            ambiguous: true,
            message: "Which drive do you mean?",
            candidates: [{ id: "j1", label: "Google – SDE" }, { id: "j2", label: "Google – Analyst" }],
        }),
        handler: async () => ({ summary: "must not run" }),
    },
    {
        name: "zz_api_error",
        description: "Fails.",
        roles: ["all"],
        handler: async () => {
            throw fail(404, "No course matches 'dbms'", "NOT_FOUND");
        },
    },
    {
        name: "zz_api_error_plain",
        description: "Fails.",
        roles: ["all"],
        handler: async () => {
            throw new ApiError(409, "Plain conflict");
        },
    },
    {
        name: "zz_api_error_details",
        description: "Fails.",
        roles: ["all"],
        handler: async () => {
            throw fail(409, "Clashes with CS301", "SCHEDULE_CONFLICT", { conflicts: [{ sessionId: "s9" }] });
        },
    },
    {
        name: "zz_ambiguous",
        description: "Ambiguous.",
        roles: ["all"],
        handler: async () => ({
            ambiguous: true,
            message: "Which course?",
            candidates: [{ id: "c1", label: "CS301 A" }, { _id: "c2", name: "CS301 B", section: "B" }, null, { label: "no id" }],
        }),
    },
    {
        name: "zz_crash",
        description: "Crashes.",
        roles: ["all"],
        handler: async () => {
            throw new Error("boom: secret internals");
        },
    },
    {
        name: "zz_cast_error",
        description: "Looks up a malformed id.",
        roles: ["all"],
        handler: async () => {
            await mongoose.models.User.findById("not-an-id");
            return { summary: "unreachable" };
        },
    },
    { name: "zz_minimal", description: "Returns nothing useful.", roles: ["all"], handler: async () => ({}) },
    {
        name: "zz_soft_fail",
        description: "Reports failure by return value.",
        roles: ["all"],
        handler: async () => ({ ok: false, error: "NO_FREE_SLOT", message: "No free slot this week" }),
    },
    {
        name: "zz_handler_wants_confirmation",
        description: "A handler that (wrongly) asks for confirmation.",
        roles: ["all"],
        handler: async () => ({ ok: false, needs_confirmation: true, preview: "Really?" }),
    },
    {
        name: "zz_preview_shaped",
        description: "Its preview returns a needs_confirmation-shaped object.",
        roles: ["student"],
        confirm: true,
        parameters: { type: "object", properties: { job: { type: "string" } } },
        preview: async (args) => ({ ok: false, needs_confirmation: true, preview: `Apply to ${args.job}?`, args: { job: "id-1" } }),
        handler: async () => ({ summary: "applied" }),
    },
];

describe("agent-tools module", () => {
    let app;
    let registry;
    let validate;
    let AgentToolCall;
    let fakeTools;
    const calls = { schedule: [], generic: [], previewError: [] };
    let student;
    let teacher;
    let tpo;
    let admin;
    let company;
    let alumni;

    const manifest = (user, claims) => request(app).get("/api/v1/agent-tools/manifest").set(bearer(agentToolToken(user, claims)));
    const execute = (user, body, claims) => request(app).post("/api/v1/agent-tools/execute")
        .set(bearer(agentToolToken(user, claims))).send(body);
    const toolNames = async (user) => (await manifest(user)).body.data.tools.map((tool) => tool.name);
    const audit = (user, query = "") => request(app).get(`/api/v1/agent-tools/audit${query}`).set(authHeader(user));

    before(async () => {
        await connectTestDb("agent_tools");
        app = await getApp();
        registry = await import("../src/modules/agent-tools/registry.js");
        validate = await import("../src/modules/agent-tools/validate.js");
        ({ AgentToolCall } = await import("../src/modules/agent-tools/agent-tool-call.model.js"));
        const { fail } = await import("../src/core/http.js");
        const { ApiError } = await import("../src/utils/api-error.js");
        fakeTools = makeFakeTools({ fail, ApiError, calls });
        registry.resetExtraTools();
        registry.registerExtraTools(fakeTools);
        [student, teacher, tpo, admin, company, alumni] = await Promise.all([
            createUser({ role: "student", branch: "CSE", section: "A" }),
            createUser({ role: "teacher", department: "CSE" }),
            createUser({ role: "tpo" }),
            createUser({ role: "admin" }),
            createUser({ role: "company" }),
            createUser({ role: "alumni" }),
        ]);
    });

    after(async () => {
        registry?.resetExtraTools();
        await disconnectTestDb();
    });

    describe("tool token", () => {
        it("accepts a valid tool token", async () => {
            const res = await manifest(student);
            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.role, "student");
        });

        it("rejects requests without a bearer token", async () => {
            assert.equal((await request(app).get("/api/v1/agent-tools/manifest")).status, 401);
            const res = await request(app).post("/api/v1/agent-tools/execute").send({ tool: "zz_echo", args: { text: "x" } });
            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.equal(res.body.errors[0].code, "UNAUTHORIZED");
        });

        it("rejects a normal access token, in the header or as a cookie", async () => {
            assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(authHeader(student))).status, 401);
            const viaExecute = await request(app).post("/api/v1/agent-tools/execute").set(authHeader(student))
                .send({ tool: "zz_echo", args: { text: "x" } });
            assert.equal(viaExecute.status, 401);
            const cookieOnly = await request(app).get("/api/v1/agent-tools/manifest")
                .set("Cookie", `accessToken=${agentToolToken(student)}`);
            assert.equal(cookieOnly.status, 401, "tool tokens are only read from the Authorization header");
        });

        it("rejects expired, wrongly typed, foreign, unsigned and non-expiring tokens", async () => {
            const secret = process.env.AGENT_TOOL_SECRET;
            const sub = String(student._id);
            const expired = jwt.sign({ sub, role: "student", typ: "agent-tool" }, secret, { expiresIn: -10 });
            const expiredRes = await request(app).get("/api/v1/agent-tools/manifest").set(bearer(expired));
            assert.equal(expiredRes.status, 401);
            assert.equal(expiredRes.body.errors[0].code, "TOKEN_EXPIRED");

            const wrongType = agentToolToken(student, { typ: "access" });
            const noType = jwt.sign({ sub, role: "student" }, secret, { expiresIn: "15m" });
            const foreign = jwt.sign({ sub, role: "student", typ: "agent-tool" }, "some-other-secret", { expiresIn: "15m" });
            const accessSecret = jwt.sign({ sub, role: "student", typ: "agent-tool" }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "15m" });
            const noExpiry = jwt.sign({ sub, role: "student", typ: "agent-tool" }, secret);
            const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
            const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub, typ: "agent-tool", exp: Math.floor(Date.now() / 1000) + 600 })}.`;
            const hs512 = jwt.sign({ sub, typ: "agent-tool" }, secret, { algorithm: "HS512", expiresIn: "15m" });
            for (const [label, token] of Object.entries({ wrongType, noType, foreign, accessSecret, noExpiry, unsigned, hs512, garbage: "not-a-jwt" })) {
                const res = await request(app).get("/api/v1/agent-tools/manifest").set(bearer(token));
                assert.equal(res.status, 401, `${label} must be rejected`);
            }
        });

        it("rejects tokens of deleted, deactivated or malformed users", async () => {
            const { User } = await import("../src/models/user.models.js");
            const gone = await createUser();
            const goneToken = agentToolToken(gone);
            await User.deleteOne({ _id: gone._id });
            assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(bearer(goneToken))).status, 401);

            const inactive = await createUser({ isActive: false });
            const inactiveRes = await execute(inactive, { tool: "zz_echo", args: { text: "x" } });
            assert.equal(inactiveRes.status, 401);
            assert.equal(inactiveRes.body.errors[0].code, "ACCOUNT_DISABLED");

            // Deactivated after the token was minted: the user is re-loaded on every call.
            const later = await createUser();
            const laterToken = agentToolToken(later);
            assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(bearer(laterToken))).status, 200);
            await User.updateOne({ _id: later._id }, { isActive: false });
            assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(bearer(laterToken))).status, 401);

            const badSub = jwt.sign({ sub: "not-an-object-id", typ: "agent-tool" }, process.env.AGENT_TOOL_SECRET, { expiresIn: "15m" });
            assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(bearer(badSub))).status, 401);
        });

        it("re-loads the user so role changes apply immediately", async () => {
            const { User } = await import("../src/models/user.models.js");
            const promoted = await createUser({ role: "student" });
            const token = agentToolToken(promoted); // role claim "student"
            await User.updateOne({ _id: promoted._id }, { role: "teacher" });
            const res = await request(app).get("/api/v1/agent-tools/manifest").set(bearer(token));
            assert.equal(res.status, 200);
            assert.equal(res.body.data.role, "teacher");
            const names = res.body.data.tools.map((tool) => tool.name);
            assert.ok(names.includes("zz_schedule"));
            assert.ok(!names.includes("zz_student_only"));
        });
    });

    describe("manifest", () => {
        it("lists only the tools each role may use (admin = tpo tools + admin tools)", async () => {
            const studentTools = await toolNames(student);
            for (const name of ["open_panel", "get_my_profile", "zz_echo", "zz_student_only", "zz_generic_confirm"]) {
                assert.ok(studentTools.includes(name), `student should see ${name}`);
            }
            for (const name of ["zz_schedule", "zz_tpo_only", "zz_admin_only"]) {
                assert.ok(!studentTools.includes(name), `student must not see ${name}`);
            }

            const teacherTools = await toolNames(teacher);
            assert.ok(teacherTools.includes("zz_schedule"));
            for (const name of ["zz_student_only", "zz_tpo_only", "zz_admin_only"]) assert.ok(!teacherTools.includes(name));

            const tpoTools = await toolNames(tpo);
            assert.ok(tpoTools.includes("zz_tpo_only"));
            for (const name of ["zz_admin_only", "zz_student_only", "zz_schedule"]) assert.ok(!tpoTools.includes(name));

            const adminTools = await toolNames(admin);
            for (const name of ["zz_tpo_only", "zz_admin_only", "open_panel", "get_my_profile", "zz_echo"]) {
                assert.ok(adminTools.includes(name), `admin should see ${name}`);
            }
            for (const name of ["zz_student_only", "zz_schedule", "zz_generic_confirm"]) {
                assert.ok(!adminTools.includes(name), `admin must not see ${name}`);
            }

            for (const user of [company, alumni]) {
                const names = await toolNames(user);
                assert.ok(names.includes("open_panel") && names.includes("get_my_profile") && names.includes("zz_echo"));
                assert.ok(!names.includes("zz_tpo_only") && !names.includes("zz_student_only"));
            }
        });

        it("describes every tool with exactly name, description, parameters and confirm", async () => {
            for (const user of [student, teacher, tpo, admin, company, alumni]) {
                const res = await manifest(user);
                assert.equal(res.status, 200);
                assert.ok(res.body.data.tools.length > 0);
                for (const tool of res.body.data.tools) {
                    assert.deepEqual(Object.keys(tool).sort(), ["confirm", "description", "name", "parameters"]);
                    assert.match(tool.name, /^[a-z][a-z0-9_]{2,63}$/);
                    assert.equal(typeof tool.description, "string");
                    assert.equal(tool.parameters?.type, "object");
                    assert.equal(typeof tool.parameters.properties, "object");
                    assert.equal(typeof tool.confirm, "boolean");
                }
            }
            const teacherTools = (await manifest(teacher)).body.data.tools;
            assert.equal(teacherTools.find((tool) => tool.name === "zz_schedule").confirm, true);
            assert.equal(teacherTools.find((tool) => tool.name === "open_panel").confirm, false);
            const profileTool = teacherTools.find((tool) => tool.name === "get_my_profile");
            assert.deepEqual(profileTool.parameters, { type: "object", properties: {} });
        });

        it("offers open_panel exactly the role's panels from UI-ACTIONS §4", async () => {
            const users = { student, teacher, tpo, admin, company, alumni };
            for (const [role, user] of Object.entries(users)) {
                const tools = (await manifest(user)).body.data.tools;
                const openPanel = tools.find((tool) => tool.name === "open_panel");
                assert.ok(openPanel, `${role} should have open_panel`);
                assert.deepEqual(openPanel.parameters.properties.panel.enum, EXPECTED_PANELS[role], `${role} panels`);
                assert.deepEqual(openPanel.parameters.required, ["panel"]);
                assert.equal(openPanel.parameters.properties.params.type, "object");
            }
        });

        it("skips invalid definitions and keeps the first of duplicate names, warning once", async () => {
            const impostor = { name: "open_panel", description: "IMPOSTOR", roles: ["all"], handler: async () => ({ summary: "impostor" }) };
            const invalid = [
                { name: "Bad-Name", roles: ["all"], handler: async () => ({}) },
                { name: "zz_no_handler", roles: ["all"] },
                { name: "zz_no_roles", handler: async () => ({}) },
                { name: "zz_unknown_role", roles: ["wizard"], handler: async () => ({}) },
            ];
            registry.resetExtraTools();
            registry.registerExtraTools([...fakeTools, impostor, ...invalid]);
            const warn = mock.method(console, "warn", () => {});
            try {
                await manifest(student);
                const res = await manifest(student);
                const tools = res.body.data.tools;
                assert.equal(tools.filter((tool) => tool.name === "open_panel").length, 1);
                assert.notEqual(tools.find((tool) => tool.name === "open_panel").description, "IMPOSTOR");
                for (const name of ["Bad-Name", "zz_no_handler", "zz_no_roles", "zz_unknown_role"]) {
                    assert.ok(!tools.some((tool) => tool.name === name), `${name} must be skipped`);
                }
                const messages = warn.mock.calls.map((call) => String(call.arguments[0]));
                assert.equal(messages.filter((message) => message.includes('duplicate tool name "open_panel"')).length, 1);
                assert.equal(messages.filter((message) => message.includes("Bad-Name")).length, 1);
                assert.equal(messages.filter((message) => message.includes('"zz_no_handler"')).length, 1);

                const executed = await execute(student, { tool: "open_panel", args: { panel: "profile" } });
                assert.equal(executed.body.data.ok, true);
                assert.equal(executed.body.data.summary, "Opened Edit profile.");
            } finally {
                warn.mock.restore();
                registry.resetExtraTools();
                registry.registerExtraTools(fakeTools);
            }
        });
    });

    describe("argument validation", () => {
        it("coerces values, fills defaults and drops unknown keys", async () => {
            const res = await execute(student, {
                tool: "zz_echo",
                args: {
                    text: "  hi  ", count: "5", ratio: "2.5", flag: "true", level: "HIGH", tags: "solo",
                    audience: { roles: "student", branch: " CSE ", junk: 1 }, junk: "x",
                    free: { a: 1, nested: { b: [1, 2] } }, note: null, confirmed: true,
                },
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.ok, true, JSON.stringify(res.body));
            assert.deepEqual(res.body.data.data.args, {
                text: "hi", count: 5, ratio: 2.5, flag: true, level: "high", tags: ["solo"],
                audience: { roles: ["student"], branch: "CSE" }, limit: 8, free: { a: 1, nested: { b: [1, 2] } }, note: null,
            });
        });

        it("reports every invalid argument as VALIDATION with details", async () => {
            const res = await execute(student, {
                tool: "zz_echo",
                args: { count: "1.5", level: "medium", audience: {}, flag: "maybe", ratio: "abc" },
            });
            assert.equal(res.status, 200);
            const body = res.body.data;
            assert.equal(body.ok, false);
            assert.equal(body.error, "VALIDATION");
            assert.equal(body.tool, "zz_echo");
            assert.match(body.message, /^Invalid arguments for zz_echo: .*text is required/);
            const byField = Object.fromEntries(body.details.map((detail) => [detail.field, detail.code]));
            assert.deepEqual(byField, {
                text: "REQUIRED", count: "TYPE", ratio: "TYPE", flag: "TYPE", level: "ENUM", "audience.roles": "REQUIRED",
            });
            assert.ok(body.details.find((detail) => detail.field === "level").message.includes("low, high"));
        });

        it("enforces declared ranges and rejects non-object args", async () => {
            const range = await execute(student, { tool: "zz_echo", args: { text: "x", count: 99 } });
            assert.equal(range.body.data.error, "VALIDATION");
            assert.equal(range.body.data.details[0].code, "RANGE");
            for (const args of ["not json", [1, 2], 42]) {
                const res = await execute(student, { tool: "zz_echo", args });
                assert.equal(res.status, 200);
                assert.equal(res.body.data.error, "VALIDATION", `args ${JSON.stringify(args)}`);
            }
            const jsonString = await execute(student, { tool: "zz_echo", args: JSON.stringify({ text: "from json" }) });
            assert.equal(jsonString.body.data.ok, true);
            assert.equal(jsonString.body.data.data.args.text, "from json");
        });

        it("treats missing args as {} and requires a tool name", async () => {
            const profile = await execute(student, { tool: "get_my_profile" });
            assert.equal(profile.body.data.ok, true);
            const noTool = await execute(student, { args: {} });
            assert.equal(noTool.status, 200);
            assert.equal(noTool.body.data.ok, false);
            assert.equal(noTool.body.data.error, "VALIDATION");
        });

        it("is idempotent, so a confirmed re-run accepts the echoed args unchanged", () => {
            const first = validate.validateArgs(ECHO_SCHEMA, {
                text: " a ", count: "3", flag: "no", level: "LOW", tags: "[\"x\", \"\", null, 2]", audience: "{\"roles\": \"tpo\"}",
            });
            assert.equal(first.ok, true);
            assert.deepEqual(first.value, {
                text: "a", count: 3, flag: false, level: "low", tags: ["x", "2"], audience: { roles: ["tpo"] }, limit: 8,
            });
            const second = validate.validateArgs(ECHO_SCHEMA, first.value);
            assert.deepEqual(second.value, first.value);
        });

        it("splits comma-separated text given for a list of scalars", () => {
            const split = validate.validateArgs(ECHO_SCHEMA, { text: "x", tags: " React, Node.js,, SQL ", audience: { roles: "student,teacher" } });
            assert.deepEqual(split.value.tags, ["React", "Node.js", "SQL"]);
            assert.deepEqual(split.value.audience.roles, ["student", "teacher"]);
            const numbers = validate.validateArgs({ type: "object", properties: { days: { type: "array", items: { type: "integer" } } } }, { days: "1, 3" });
            assert.deepEqual(numbers.value.days, [1, 3]);
            const objects = validate.validateArgs(
                { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } } } },
                { rows: "a, b" },
            );
            assert.equal(objects.ok, false, "text is not split into objects");
        });

        it("supports unions, nullable values and Date / ObjectId coercion", () => {
            const schema = {
                type: "object",
                properties: {
                    ctc: { type: ["number", "string"] },
                    when: { type: "string" },
                    id: { type: "string" },
                    ids: { type: "array", items: { type: "integer" } },
                    options: { type: "object", properties: { strict: { type: "boolean" } } },
                    maybe: { type: "string", nullable: true },
                    gone: { type: "string" },
                },
            };
            const when = new Date("2026-12-01T05:30:00.000Z");
            const id = new mongoose.Types.ObjectId();
            const result = validate.validateArgs(schema, {
                ctc: "12.5", when, id, ids: "[1, \"2\"]", options: "{\"strict\": \"yes\"}", maybe: null, gone: null,
            });
            assert.equal(result.ok, true);
            assert.deepEqual(result.value, {
                ctc: 12.5, when: when.toISOString(), id: id.toHexString(), ids: [1, 2], options: { strict: true }, maybe: null,
            });
            assert.equal(validate.validateArgs(schema, { ctc: "about 12 LPA" }).value.ctc, "about 12 LPA");
            const wrong = validate.validateArgs(schema, { ctc: { amount: 12 } });
            assert.equal(wrong.ok, false);
            assert.equal(wrong.errors[0].message, "ctc must be a number or text");
        });

        it("never lets prototype keys through", () => {
            const input = JSON.parse('{"text":"x","__proto__":{"polluted":true},"free":{"__proto__":{"polluted":true},"ok":1}}');
            const result = validate.validateArgs(ECHO_SCHEMA, input);
            assert.equal(result.ok, true);
            assert.equal(({}).polluted, undefined);
            assert.equal(result.value.polluted, undefined);
            assert.equal(Object.getPrototypeOf(result.value.free), Object.prototype);
            assert.deepEqual(result.value.free, { ok: 1 });
        });
    });

    describe("execute", () => {
        it("answers an unknown tool with UNKNOWN_TOOL (HTTP 200)", async () => {
            const res = await execute(student, { tool: "launch_rockets", args: {} });
            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.ok, false);
            assert.equal(res.body.data.error, "UNKNOWN_TOOL");
            assert.equal(typeof res.body.data.message, "string");
        });

        it("answers a tool outside the caller's role with FORBIDDEN", async () => {
            const res = await execute(student, { tool: "zz_schedule", args: { course: "CS302", when: "tomorrow 10am" } });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.ok, false);
            assert.equal(res.body.data.error, "FORBIDDEN");
            assert.equal((await execute(teacher, { tool: "zz_tpo_only" })).body.data.error, "FORBIDDEN");
            assert.equal((await execute(tpo, { tool: "zz_admin_only" })).body.data.error, "FORBIDDEN");
            assert.equal(calls.schedule.length, 0);
        });

        it("treats admin as a superuser over tpo tools only", async () => {
            const tpoTool = await execute(admin, { tool: "zz_tpo_only" });
            assert.equal(tpoTool.body.data.ok, true);
            assert.equal(tpoTool.body.data.summary, "tpo ok as admin");
            assert.equal((await execute(admin, { tool: "zz_admin_only" })).body.data.ok, true);
            assert.equal((await execute(admin, { tool: "zz_schedule", args: { course: "x", when: "y" } })).body.data.error, "FORBIDDEN");
            assert.equal((await execute(admin, { tool: "zz_student_only" })).body.data.error, "FORBIDDEN");
        });

        it("passes ctx = {user, role, requestId, sessionId, now, timezone} to the handler", async () => {
            const res = await execute(student, { tool: "zz_echo", args: { text: "ctx" } }, { rid: "req-42", sid: "sess-7" });
            assert.equal(res.body.data.ok, true);
            assert.deepEqual(res.body.data.data.ctx, {
                role: "student", userId: String(student._id), requestId: "req-42", sessionId: "sess-7",
                nowIsDate: true, timezone: process.env.APP_TIMEZONE, hasPassword: false,
            });
        });

        it("asks for confirmation with the tool's preview and normalised args, without side effects", async () => {
            const res = await execute(teacher, { tool: "zz_schedule", args: { course: "cs302", when: "next monday 11am" } });
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, {
                ok: false,
                needs_confirmation: true,
                tool: "zz_schedule",
                args: { course: "id-cs302", when: "next monday 11am", durationMinutes: 60 },
                preview: "Schedule CS302 at next monday 11am?",
            });
            assert.equal(calls.schedule.length, 0);

            const notBoolean = await execute(teacher, { tool: "zz_schedule", args: res.body.data.args, confirmed: "true" });
            assert.equal(notBoolean.body.data.needs_confirmation, true, "only the boolean true confirms");
            assert.equal(calls.schedule.length, 0);

            const done = await execute(teacher, { tool: "zz_schedule", args: res.body.data.args, confirmed: true });
            assert.deepEqual(done.body.data, {
                ok: true,
                tool: "zz_schedule",
                summary: "Scheduled id-cs302.",
                data: { args: { course: "id-cs302", when: "next monday 11am", durationMinutes: 60 } },
                ui: { panel: "teacher.schedule", params: { sessionId: "s1" } },
            });
            assert.equal(calls.schedule.length, 1);
        });

        it("builds a generic preview from the description and args when the tool has none", async () => {
            const res = await execute(student, { tool: "zz_generic_confirm", args: { job: "Google SDE", count: "2" } });
            assert.equal(res.body.data.needs_confirmation, true);
            assert.deepEqual(res.body.data.args, { job: "Google SDE", count: 2 });
            assert.equal(res.body.data.preview, 'Withdraw a pretend application — job: "Google SDE", count: 2?');
            assert.equal(calls.generic.length, 0);
            const done = await execute(student, { tool: "zz_generic_confirm", args: res.body.data.args, confirmed: true });
            assert.equal(done.body.data.ok, true);
            assert.equal(done.body.data.summary, "withdrawn");
            assert.deepEqual(calls.generic, [{ job: "Google SDE", count: 2 }]);
        });

        it("maps preview errors like handler errors instead of asking for confirmation", async () => {
            const failed = await execute(student, { tool: "zz_preview_error" });
            assert.equal(failed.status, 200);
            assert.deepEqual(failed.body.data, {
                ok: false, tool: "zz_preview_error", error: "ALREADY_APPLIED", message: "You already applied to this drive",
            });
            const ambiguous = await execute(student, { tool: "zz_preview_ambiguous", args: { job: "google" } });
            assert.equal(ambiguous.body.data.ok, false);
            assert.equal(ambiguous.body.data.error, "AMBIGUOUS");
            assert.equal(ambiguous.body.data.needs_confirmation, undefined);
            assert.deepEqual(ambiguous.body.data.candidates, [{ id: "j1", label: "Google – SDE" }, { id: "j2", label: "Google – Analyst" }]);
            assert.equal(calls.previewError.length, 0);
        });

        it("maps handler ApiErrors to their code and message", async () => {
            const notFound = await execute(student, { tool: "zz_api_error" });
            assert.equal(notFound.status, 200);
            assert.deepEqual(notFound.body.data, { ok: false, tool: "zz_api_error", error: "NOT_FOUND", message: "No course matches 'dbms'" });
            const plain = await execute(student, { tool: "zz_api_error_plain" });
            assert.equal(plain.body.data.error, "ERROR");
            assert.equal(plain.body.data.message, "Plain conflict");
            const detailed = await execute(student, { tool: "zz_api_error_details" });
            assert.equal(detailed.body.data.error, "SCHEDULE_CONFLICT");
            assert.deepEqual(detailed.body.data.details, [{ code: "SCHEDULE_CONFLICT", conflicts: [{ sessionId: "s9" }] }]);
        });

        it("returns AMBIGUOUS with normalised {id, label} candidates", async () => {
            const res = await execute(student, { tool: "zz_ambiguous" });
            assert.equal(res.status, 200);
            const body = res.body.data;
            assert.equal(body.ok, false);
            assert.equal(body.error, "AMBIGUOUS");
            assert.equal(body.message, "Which course?");
            assert.equal(body.candidates.length, 2);
            assert.deepEqual(body.candidates[0], { id: "c1", label: "CS301 A" });
            assert.equal(body.candidates[1].id, "c2");
            assert.equal(body.candidates[1].label, "CS301 B");
        });

        it("hides unexpected errors behind INTERNAL and logs them server-side", async () => {
            const logged = mock.method(console, "error", () => {});
            try {
                const res = await execute(student, { tool: "zz_crash" });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data, { ok: false, tool: "zz_crash", error: "INTERNAL", message: "Tool failed" });
                assert.ok(!JSON.stringify(res.body).includes("boom"));
                assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes('"zz_crash"')));
            } finally {
                logged.mock.restore();
            }
        });

        it("maps Mongoose cast errors to VALIDATION", async () => {
            const res = await execute(student, { tool: "zz_cast_error" });
            assert.equal(res.body.data.ok, false);
            assert.equal(res.body.data.error, "VALIDATION");
        });

        it("maps failures returned (not thrown) by tools", async () => {
            const soft = await execute(student, { tool: "zz_soft_fail" });
            assert.deepEqual(soft.body.data, { ok: false, tool: "zz_soft_fail", error: "NO_FREE_SLOT", message: "No free slot this week" });
            const wrongShape = await execute(student, { tool: "zz_handler_wants_confirmation" });
            assert.equal(wrongShape.body.data.ok, false, "a handler that says ok:false is never reported as ok");
            assert.equal(wrongShape.body.data.needs_confirmation, undefined);
            const previewShaped = await execute(student, { tool: "zz_preview_shaped", args: { job: "Google" } });
            assert.deepEqual(previewShaped.body.data, {
                ok: false, needs_confirmation: true, tool: "zz_preview_shaped", args: { job: "id-1" }, preview: "Apply to Google?",
            });
        });

        it("fills a default summary and null data, and drops malformed ui entries", async () => {
            const minimal = await execute(student, { tool: "zz_minimal" });
            assert.deepEqual(minimal.body.data, { ok: true, tool: "zz_minimal", summary: "Done.", data: null });
            const echo = await execute(student, { tool: "zz_echo", args: { text: "ui" } });
            assert.deepEqual(echo.body.data.ui, [{ panel: "profile", params: { tab: "x" } }]);
        });
    });

    describe("open_panel", () => {
        it("opens one of the caller's panels", async () => {
            const res = await execute(student, { tool: "open_panel", args: { panel: "attendance.student" } });
            assert.equal(res.status, 200);
            assert.equal(res.body.data.ok, true, JSON.stringify(res.body));
            assert.equal(res.body.data.summary, "Opened My attendance.");
            assert.deepEqual(res.body.data.ui, { panel: "attendance.student", params: {} });
        });

        it("rejects panels outside the caller's role", async () => {
            const denied = await execute(student, { tool: "open_panel", args: { panel: "tpo.faculty" } });
            assert.equal(denied.status, 200);
            assert.equal(denied.body.data.ok, false);
            assert.equal(denied.body.data.error, "VALIDATION");
            assert.match(denied.body.data.message, /panel must be one of: student\.home/);
            assert.equal((await execute(company, { tool: "open_panel", args: { panel: "tpo.home" } })).body.data.ok, false);
            assert.equal((await execute(teacher, { tool: "open_panel", args: { panel: "attendance.student" } })).body.data.ok, false);
            assert.equal((await execute(tpo, { tool: "open_panel", args: { panel: "tpo.jobfeed" } })).body.data.ok, false);
            assert.equal((await execute(student, { tool: "open_panel", args: {} })).body.data.error, "VALIDATION");
        });

        it("keeps canonical params (typed) and small scalar extras, dropping nested values", async () => {
            const res = await execute(teacher, {
                tool: "open_panel",
                args: {
                    panel: "Teacher.Analytics",
                    params: { courseId: "c1", threshold: "75", junk: { deep: 1 }, label: " x ", ids: ["a", "b", {}], empty: "" },
                },
            });
            assert.equal(res.body.data.ok, true, JSON.stringify(res.body));
            assert.deepEqual(res.body.data.ui, {
                panel: "teacher.analytics",
                params: { courseId: "c1", threshold: 75, label: "x", ids: ["a", "b"] },
            });
        });

        it("lets admin open TPO panels", async () => {
            const res = await execute(admin, { tool: "open_panel", args: { panel: "tpo.attendance", params: { courseId: "c9" } } });
            assert.equal(res.body.data.ok, true);
            assert.deepEqual(res.body.data.ui, { panel: "tpo.attendance", params: { courseId: "c9" } });
        });
    });

    describe("get_my_profile", () => {
        const ensureModel = (name, collection) => mongoose.models[name]
            || mongoose.model(name, new mongoose.Schema({}, { strict: false, collection }));

        it("summarises a student's profile with resume and attendance counts", async () => {
            const { College } = await import("../src/models/college.models.js");
            const college = await College.create({ name: "Demo Institute of Technology", domain: `demo-${suffix()}.edu` });
            const me = await createUser({
                role: "student", name: "Asha Verma", branch: "CSE", section: "A", semester: 5, passingYear: "2027",
                cgpa: 8.4, skills: ["React", "Node.js", "SQL"], college: college._id,
            });

            const Resume = mongoose.models.Resume;
            if (Resume) {
                const now = new Date();
                await Resume.collection.insertMany([1, 2, 3].map((version) => ({
                    owner: me._id, title: `CV ${version}`, version, sourceHash: `hash-${me._id}-${version}`,
                    dedupeKey: `dedupe-${me._id}-${version}`, status: version === 3 ? "archived" : "active", createdAt: now, updatedAt: now,
                })));
            }

            // 4 ended sessions (present, late, absent, excused) + 1 live one that must not count.
            const Session = ensureModel("ClassSession", "class_sessions");
            const Record = ensureModel("AttendanceRecord", "attendance_records");
            const course = new mongoose.Types.ObjectId();
            const start = Date.UTC(2026, 10, 2, 4, 30);
            const sessions = ["ended", "ended", "ended", "ended", "live"].map((status, index) => ({
                _id: new mongoose.Types.ObjectId(), course, teacher: teacher._id, status,
                startsAt: new Date(start + index * 86_400_000), endsAt: new Date(start + index * 86_400_000 + 3_600_000),
            }));
            await Session.collection.insertMany(sessions);
            const statuses = ["present", "late", "absent", "excused", "present"];
            await Record.collection.insertMany(sessions.map((session, index) => ({
                session: session._id, course, student: me._id, status: statuses[index], method: "manual", markedAt: new Date(),
            })));

            const res = await execute(me, { tool: "get_my_profile", args: {} });
            assert.equal(res.status, 200);
            const body = res.body.data;
            assert.equal(body.ok, true, JSON.stringify(res.body));
            assert.equal(body.ui, undefined, "get_my_profile opens no panel");
            const { profile } = body.data;
            assert.equal(profile.name, "Asha Verma");
            assert.equal(profile.email, me.email);
            assert.equal(profile.role, "student");
            assert.equal(profile.branch, "CSE");
            assert.equal(profile.section, "A");
            assert.equal(profile.semester, 5);
            assert.equal(profile.passingYear, "2027");
            assert.equal(profile.cgpa, 8.4);
            assert.deepEqual(profile.skills, ["React", "Node.js", "SQL"]);
            assert.equal(profile.college?.name, "Demo Institute of Technology");
            if (Resume) assert.equal(profile.resumeCount, 2);
            assert.deepEqual(profile.attendance, { attended: 2, held: 4, percent: 66.7 });
            for (const fragment of ["Asha Verma", "student at Demo Institute of Technology", "CGPA 8.4", "Skills: React, Node.js, SQL", "Attendance 66.7%"]) {
                assert.ok(body.summary.includes(fragment), `summary should mention "${fragment}": ${body.summary}`);
            }
            assert.ok(!body.summary.includes(me.email), "the summary does not repeat the email");
        });

        it("shows a teacher's department", async () => {
            const professor = await createUser({ role: "teacher", name: "Dr. Rao", department: "CSE", designation: "Assistant Professor" });
            const res = await execute(professor, { tool: "get_my_profile" });
            assert.equal(res.body.data.ok, true);
            const { profile } = res.body.data.data;
            assert.equal(profile.role, "teacher");
            assert.equal(profile.department, "CSE");
            assert.equal(profile.cgpa, undefined, "student fields do not apply to teachers");
            assert.ok(res.body.data.summary.includes("CSE department"));
        });

        it("works for every role", async () => {
            for (const user of [tpo, admin, company, alumni]) {
                const res = await execute(user, { tool: "get_my_profile" });
                assert.equal(res.body.data.ok, true, `${user.role}: ${JSON.stringify(res.body)}`);
                assert.equal(res.body.data.data.profile.role, user.role);
                assert.ok(res.body.data.summary.startsWith(user.name));
            }
        });
    });

    describe("audit trail", () => {
        it("records executions, confirmation previews and failures", async () => {
            const res = await audit(tpo, "?limit=200");
            assert.equal(res.status, 200);
            const { items, total, page, limit } = res.body.data;
            assert.ok(Array.isArray(items));
            assert.ok(total >= items.length);
            assert.equal(page, 1);
            assert.equal(limit, 200);
            const confirmedRun = items.find((entry) => entry.tool === "zz_schedule" && entry.confirmed === true);
            assert.ok(confirmedRun, "the confirmed execution is recorded");
            assert.equal(confirmedRun.ok, true);
            assert.equal(confirmedRun.error, null);
            assert.equal(confirmedRun.role, "teacher");
            assert.equal(confirmedRun.module, "test");
            assert.deepEqual(confirmedRun.args, { course: "id-cs302", when: "next monday 11am", durationMinutes: 60 });
            assert.equal(confirmedRun.user.id, String(teacher._id));
            assert.equal(confirmedRun.user.email, teacher.email);
            assert.equal(confirmedRun.requestId, "test-request");
            assert.equal(confirmedRun.sessionId, "test-session");
            assert.equal(typeof confirmedRun.durationMs, "number");
            assert.ok(confirmedRun.createdAt);

            const previews = items.filter((entry) => entry.tool === "zz_schedule" && entry.error === "NEEDS_CONFIRMATION");
            assert.ok(previews.length >= 1);
            for (const preview of previews) {
                assert.equal(preview.confirmed, false);
                assert.equal(preview.ok, false);
                assert.equal(preview.message, "Schedule CS302 at next monday 11am?");
            }
            assert.ok(items.some((entry) => entry.tool === "launch_rockets" && entry.error === "UNKNOWN_TOOL"));
            assert.ok(items.some((entry) => entry.tool === "zz_schedule" && entry.error === "FORBIDDEN" && entry.role === "student"));
        });

        it("filters by tool, user and outcome, with pagination", async () => {
            const byTool = await audit(tpo, "?tool=zz_schedule&ok=true");
            assert.equal(byTool.status, 200);
            assert.ok(byTool.body.data.items.length >= 1);
            assert.ok(byTool.body.data.items.every((entry) => entry.tool === "zz_schedule" && entry.ok === true));

            const byUser = await audit(tpo, `?user=${teacher._id}`);
            assert.ok(byUser.body.data.items.length >= 1);
            assert.ok(byUser.body.data.items.every((entry) => entry.user.id === String(teacher._id)));
            const byEmail = await audit(admin, `?user=${encodeURIComponent(teacher.email)}`);
            assert.equal(byEmail.body.data.total, byUser.body.data.total);
            assert.equal((await audit(admin, "?user=nobody%40nowhere.test")).body.data.total, 0);

            const failures = await audit(tpo, "?ok=false&limit=200");
            assert.ok(failures.body.data.items.every((entry) => entry.ok === false));

            const firstPage = await audit(tpo, "?limit=1&page=1");
            const secondPage = await audit(tpo, "?limit=1&page=2");
            assert.equal(firstPage.body.data.items.length, 1);
            assert.equal(firstPage.body.data.hasNextPage, true);
            assert.notEqual(firstPage.body.data.items[0].id, secondPage.body.data.items[0].id);
            assert.ok(new Date(firstPage.body.data.items[0].createdAt) >= new Date(secondPage.body.data.items[0].createdAt));

            assert.equal((await audit(tpo, "?ok=maybe")).status, 400);
            assert.equal((await audit(tpo, "?user=bogus")).status, 400);
        });

        it("truncates long strings and redacts credential-like keys in stored args", async () => {
            const longText = "x".repeat(5000);
            const res = await execute(student, {
                tool: "zz_echo",
                args: { text: longText, free: { apiKey: "sk-live-123", nested: { accessToken: "t0k" }, passingYear: "2027" } },
            });
            assert.equal(res.body.data.ok, true);
            assert.equal(res.body.data.data.args.text.length, 5000, "the handler still receives the full value");
            const entry = await AgentToolCall.findOne({ user: student._id, tool: "zz_echo" }).sort({ createdAt: -1 }).lean();
            assert.ok(entry.args.text.length < 600);
            assert.ok(entry.args.text.endsWith("(+4500 chars)"));
            assert.equal(entry.args.free.apiKey, "[redacted]");
            assert.equal(entry.args.free.nested.accessToken, "[redacted]");
            assert.equal(entry.args.free.passingYear, "2027");
        });

        it("scopes a TPO to their own college; admin sees everything", async () => {
            const { College } = await import("../src/models/college.models.js");
            const college = await College.create({ name: "Scoped College", domain: `scoped-${suffix()}.edu` });
            const scopedTpo = await createUser({ role: "tpo", college: college._id });
            const scopedStudent = await createUser({ role: "student", college: college._id });
            assert.equal((await execute(scopedStudent, { tool: "zz_echo", args: { text: "scoped" } })).body.data.ok, true);

            const own = (await audit(scopedTpo, "?limit=200")).body.data.items;
            assert.ok(own.length >= 1);
            assert.ok(own.every((entry) => entry.user.id === String(scopedStudent._id)));
            const unscoped = (await audit(tpo, "?limit=200")).body.data.items;
            assert.ok(!unscoped.some((entry) => entry.user.id === String(scopedStudent._id)));
            const everything = (await audit(admin, "?limit=200")).body.data.items;
            assert.ok(everything.some((entry) => entry.user.id === String(scopedStudent._id)));
            assert.ok(everything.some((entry) => entry.user.id === String(teacher._id)));
        });

        it("is only for TPO/admin with a normal access token", async () => {
            assert.equal((await audit(admin)).status, 200);
            assert.equal((await audit(student)).status, 403);
            assert.equal((await audit(teacher)).status, 403);
            assert.equal((await audit(company)).status, 403);
            const withToolToken = await request(app).get("/api/v1/agent-tools/audit").set(bearer(agentToolToken(tpo)));
            assert.equal(withToolToken.status, 401);
            assert.equal((await request(app).get("/api/v1/agent-tools/audit")).status, 401);
        });

        it("expires records after 30 days (TTL index on agent_tool_calls)", async () => {
            await AgentToolCall.init();
            assert.equal(AgentToolCall.collection.collectionName, "agent_tool_calls");
            const indexes = await AgentToolCall.collection.indexes();
            const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
            assert.deepEqual(ttl?.key, { createdAt: 1 });
            assert.equal(ttl.expireAfterSeconds, 30 * 24 * 60 * 60);
        });
    });
});
