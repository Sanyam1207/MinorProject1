// Black-box contract test for docs/contracts/AGENT-TOOLS.md §1–§4 (the
// security boundary between the Python copilot and the backend).
import { connectTestDb, disconnectTestDb, createUser, authHeader, agentToolToken, getApp } from "../helpers.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe("agent tools contract", () => {
    let app;
    let student;
    let teacher;
    let tpo;
    let course;

    before(async () => {
        await connectTestDb("agent_tools_contract");
        app = await getApp();
        student = await createUser({ role: "student", branch: "CSE", section: "A" });
        teacher = await createUser({ role: "teacher", department: "CSE" });
        tpo = await createUser({ role: "tpo" });
        const res = await request(app).post("/api/v1/attendance/courses").set(authHeader(teacher))
            .send({ code: "CS302", name: "Computer Networks", branch: "CSE", section: "A" });
        course = res.body?.data?.course;
    });
    after(disconnectTestDb);

    it("rejects a normal access token on the tool API", async () => {
        const res = await request(app).get("/api/v1/agent-tools/manifest").set(authHeader(student));
        assert.equal(res.status, 401);
    });

    it("rejects a tool token on normal API routes", async () => {
        const res = await request(app).get("/api/v1/auth/me").set(bearer(agentToolToken(student)));
        assert.equal(res.status, 401);
    });

    it("rejects expired or wrongly typed tool tokens", async () => {
        const expired = jwt.sign({ sub: String(student._id), role: "student", typ: "agent-tool" }, process.env.AGENT_TOOL_SECRET, { expiresIn: -10 });
        assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(bearer(expired))).status, 401);
        const wrongType = agentToolToken(student, { typ: "access" });
        assert.equal((await request(app).get("/api/v1/agent-tools/manifest").set(bearer(wrongType))).status, 401);
    });

    it("filters the manifest by role", async () => {
        const studentManifest = await request(app).get("/api/v1/agent-tools/manifest").set(bearer(agentToolToken(student)));
        assert.equal(studentManifest.status, 200);
        const studentTools = studentManifest.body.data.tools.map((tool) => tool.name);
        assert.ok(studentTools.includes("open_panel"));
        assert.ok(studentTools.includes("attendance_my_summary"));
        assert.ok(!studentTools.includes("attendance_schedule_class"), "students must not see teacher tools");

        const teacherManifest = await request(app).get("/api/v1/agent-tools/manifest").set(bearer(agentToolToken(teacher)));
        const teacherTools = teacherManifest.body.data.tools.map((tool) => tool.name);
        assert.ok(teacherTools.includes("attendance_schedule_class"));
        for (const tool of teacherManifest.body.data.tools) {
            assert.equal(typeof tool.description, "string");
            assert.equal(tool.parameters?.type, "object");
            assert.equal(typeof tool.confirm, "boolean");
        }
    });

    it("maps unknown and forbidden tools to ok:false (HTTP 200)", async () => {
        const unknown = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(student)))
            .send({ tool: "launch_rockets", args: {} });
        assert.equal(unknown.status, 200);
        assert.equal(unknown.body.data.ok, false);
        assert.equal(unknown.body.data.error, "UNKNOWN_TOOL");

        const forbidden = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(student)))
            .send({ tool: "attendance_schedule_class", args: { course: "CS302", when: "tomorrow 10am" } });
        assert.equal(forbidden.body.data.ok, false);
        assert.equal(forbidden.body.data.error, "FORBIDDEN");
    });

    it("requires explicit confirmation for side-effecting tools", async () => {
        assert.ok(course?._id, "course setup failed");
        const preview = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(teacher)))
            .send({ tool: "attendance_schedule_class", args: { course: "cs302", when: "next monday 11am", durationMinutes: 50 } });
        assert.equal(preview.status, 200);
        assert.equal(preview.body.data.ok, false);
        assert.equal(preview.body.data.needs_confirmation, true);
        assert.equal(typeof preview.body.data.preview, "string");

        const done = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(teacher)))
            .send({ tool: "attendance_schedule_class", args: preview.body.data.args, confirmed: true });
        assert.equal(done.body.data.ok, true, JSON.stringify(done.body));
        assert.equal(typeof done.body.data.summary, "string");
        const ui = Array.isArray(done.body.data.ui) ? done.body.data.ui[0] : done.body.data.ui;
        assert.equal(typeof ui?.panel, "string");
    });

    it("validates arguments", async () => {
        const res = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(teacher)))
            .send({ tool: "attendance_schedule_class", args: { when: "tomorrow" } });
        assert.equal(res.body.data.ok, false);
        assert.equal(res.body.data.error, "VALIDATION");
    });

    it("open_panel returns a UI action and rejects panels outside the role", async () => {
        const ok = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(student)))
            .send({ tool: "open_panel", args: { panel: "attendance.student" } });
        assert.equal(ok.body.data.ok, true, JSON.stringify(ok.body));
        const ui = Array.isArray(ok.body.data.ui) ? ok.body.data.ui[0] : ok.body.data.ui;
        assert.equal(ui.panel, "attendance.student");

        const denied = await request(app).post("/api/v1/agent-tools/execute").set(bearer(agentToolToken(student)))
            .send({ tool: "open_panel", args: { panel: "tpo.faculty" } });
        assert.equal(denied.body.data.ok, false);
    });

    it("records an audit trail visible to TPO/admin only", async () => {
        const asTpo = await request(app).get("/api/v1/agent-tools/audit").set(authHeader(tpo));
        assert.equal(asTpo.status, 200);
        const entries = Array.isArray(asTpo.body.data) ? asTpo.body.data : asTpo.body.data.items;
        assert.ok(entries.some((entry) => entry.tool === "attendance_schedule_class" && entry.confirmed === true));
        const asStudent = await request(app).get("/api/v1/agent-tools/audit").set(authHeader(student));
        assert.equal(asStudent.status, 403);
    });
});
