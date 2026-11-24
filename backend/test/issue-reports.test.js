// Acceptance tests for docs/contracts/AUTH-FACULTY.md §9, §10.2 / §17 issue-reports.test.js.
import { connectTestDb, disconnectTestDb, createUser, authHeader, agentToolToken, getApp } from "./helpers.js";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.TPO_EMAIL = "tpo@demo.edu";
process.env.TPO_INITIAL_PASSWORD = "Init-Pass-123";
process.env.TEACHER_EMAILS = "new.teacher@demo.edu,far.teacher@unknown.org";
process.env.CLIENT_ID = "";
process.env.ENABLE_RATE_LIMIT_IN_TESTS = "false";

describe("issue reports (AUTH-FACULTY §9)", () => {
    let app;
    let mongoose;
    let IssueReport;
    let collegeA;
    let collegeB;
    let tpoA;
    let tpoB;
    let admin;
    let student;
    let tools;

    before(async () => {
        await connectTestDb("issue_reports");
        app = await getApp();
        ({ default: mongoose } = await import("mongoose"));
        ({ IssueReport } = await import("../src/modules/issue-reports/issue-report.model.js"));
        ({ default: tools } = await import("../src/modules/issue-reports/tools.js"));
        const { College } = await import("../src/models/college.models.js");
        collegeA = await College.create({ name: "Demo Institute of Technology", domain: "demo.edu" });
        collegeB = await College.create({ name: "Other College", domain: "other.edu" });
        tpoA = await createUser({ role: "tpo", name: "TPO A", email: "tpo.a@demo.edu", college: collegeA._id });
        tpoB = await createUser({ role: "tpo", name: "TPO B", email: "tpo.b@other.edu", college: collegeB._id });
        await College.updateOne({ _id: collegeA._id }, { tpo: tpoA._id });
        admin = await createUser({ role: "admin", email: "root@platform.io" });
        student = await createUser({ role: "student", name: "Asha Verma", email: "asha@demo.edu", college: collegeA._id });
    });
    after(disconnectTestDb);
    afterEach(() => {
        process.env.ENABLE_RATE_LIMIT_IN_TESTS = "false";
    });

    const codeOf = (res) => res.body?.errors?.[0]?.code;
    const submit = (body, user) => {
        const req = request(app).post("/api/v1/issue-reports").set("User-Agent", "test-agent/1.0");
        if (user) req.set(authHeader(user));
        return req.send(body);
    };

    it("stores a valid anonymous report", async () => {
        const res = await submit({ name: "Visitor", email: "Visitor@Example.com", description: "  The login page is blank.  ", page: "auth" });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.message, "Thanks for reporting this. We'll take a look soon.");
        const report = await IssueReport.findById(res.body.data.id).lean();
        assert.equal(report.status, "open");
        assert.equal(report.user, null);
        assert.equal(report.college, null);
        assert.equal(report.email, "visitor@example.com");
        assert.equal(report.description, "The login page is blank.");
        assert.equal(report.page, "auth");
        assert.equal(report.userAgent, "test-agent/1.0");
    });

    it("answers invalid input with 400 VALIDATION, never 500", async () => {
        const missing = await submit({ name: "Visitor", email: "v@example.com" });
        assert.equal(missing.status, 400);
        assert.equal(codeOf(missing), "VALIDATION");
        assert.equal(missing.body.message, "Name, email, and issue description are required.");
        const badEmail = await submit({ name: "Visitor", email: "nope", description: "x" });
        assert.equal(badEmail.status, 400);
        assert.equal(badEmail.body.message, "Please enter a valid email address.");
        const tooLong = await submit({ name: "Visitor", email: "v@example.com", description: "x".repeat(5001) });
        assert.equal(tooLong.status, 400);
        assert.equal(codeOf(tooLong), "VALIDATION");
        const longName = await submit({ name: "n".repeat(121), email: "v@example.com", description: "x" });
        assert.equal(longName.status, 400);
        const exact = await submit({ name: "Visitor", email: "v@example.com", description: "y".repeat(5000) });
        assert.equal(exact.status, 201);
    });

    it("takes a signed-in reporter's identity from the account and notifies staff", async () => {
        const res = await submit({ description: "QR scanner asks for camera permission twice", email: "spoof@evil.com", name: "Spoofer", page: "attendance.scan" }, student);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const report = await IssueReport.findById(res.body.data.id).lean();
        assert.equal(report.name, "Asha Verma");
        assert.equal(report.email, "asha@demo.edu");
        assert.equal(String(report.user), String(student._id));
        assert.equal(report.role, "student");
        assert.equal(String(report.college), String(collegeA._id));

        const Notification = mongoose.models.Notification;
        if (Notification) {
            const forTpo = await Notification.findOne({ user: tpoA._id, type: "issue.new" }).lean();
            assert.ok(forTpo, "the college TPO is notified");
            assert.equal(forTpo.title, "New issue report from Asha Verma");
            assert.equal(forTpo.priority, "low");
            assert.deepEqual(forTpo.ui, { panel: "tpo.issues", params: { reportId: String(report._id) } });
            assert.ok(await Notification.exists({ user: admin._id, type: "issue.new" }), "admins are notified");
            assert.equal(await Notification.countDocuments({ user: tpoB._id, type: "issue.new" }), 0, "other colleges are not");
            assert.equal(await Notification.countDocuments({ user: student._id, type: "issue.new" }), 0, "never the reporter");
        }
    });

    it("pretends success for the honeypot and stores nothing", async () => {
        const before = await IssueReport.countDocuments();
        const res = await submit({ name: "Bot", email: "bot@spam.io", description: "Buy now", website: "http://spam.io" });
        assert.equal(res.status, 201);
        assert.match(res.body.data.id, /^[a-f\d]{24}$/);
        assert.equal(await IssueReport.countDocuments(), before);
    });

    it("scopes the list to the TPO's college plus anonymous reports, with counts", async () => {
        await IssueReport.create({ name: "B user", email: "b@other.edu", description: "Other college issue", college: collegeB._id, user: tpoB._id, role: "tpo" });
        assert.equal((await request(app).get("/api/v1/issue-reports").set(authHeader(student))).status, 403);

        const mine = await request(app).get("/api/v1/issue-reports").set(authHeader(tpoA));
        assert.equal(mine.status, 200, JSON.stringify(mine.body));
        const { items, total, counts, page, limit } = mine.body.data;
        assert.equal(page, 1);
        assert.equal(limit, 20);
        assert.ok(items.every((item) => item.description !== "Other college issue"));
        assert.ok(items.some((item) => item.user === null), "anonymous reports are included");
        const signedIn = items.find((item) => item.user);
        assert.deepEqual(Object.keys(signedIn.user).sort(), ["_id", "name", "role"]);
        assert.deepEqual(Object.keys(signedIn).sort(), ["_id", "createdAt", "description", "email", "name", "note", "page", "resolvedAt", "role", "status", "updatedAt", "user"]);
        assert.equal(total, items.length);
        assert.deepEqual(counts, { open: total, in_progress: 0, resolved: 0, closed: 0 });

        const all = await request(app).get("/api/v1/issue-reports").set(authHeader(admin));
        assert.equal(all.body.data.total, total + 1, "admin sees every college");
        const other = await request(app).get("/api/v1/issue-reports").set(authHeader(tpoB));
        assert.ok(other.body.data.items.some((item) => item.description === "Other college issue"));
        assert.ok(other.body.data.items.every((item) => item.email !== "asha@demo.edu"));

        const search = await request(app).get("/api/v1/issue-reports?search=camera").set(authHeader(tpoA));
        assert.equal(search.body.data.total, 1);
        assert.equal(codeOf(await request(app).get("/api/v1/issue-reports?status=weird").set(authHeader(tpoA))), "VALIDATION");
    });

    it("triages a report and notifies the reporting user", async () => {
        const created = await submit({ description: "Resume PDF preview is blank after compiling" }, student);
        const id = created.body.data.id;
        assert.equal(codeOf(await request(app).patch(`/api/v1/issue-reports/${id}`).set(authHeader(tpoB)).send({ status: "resolved" })), "NOT_FOUND");
        assert.equal(codeOf(await request(app).patch(`/api/v1/issue-reports/${id}`).set(authHeader(tpoA)).send({ status: "done" })), "VALIDATION");
        assert.equal(codeOf(await request(app).patch(`/api/v1/issue-reports/${id}`).set(authHeader(tpoA)).send({})), "VALIDATION");

        const progress = await request(app).patch(`/api/v1/issue-reports/${id}`).set(authHeader(tpoA)).send({ status: "in_progress", note: "Reproduced, fixing" });
        assert.equal(progress.status, 200, JSON.stringify(progress.body));
        assert.equal(progress.body.data.report.status, "in_progress");
        assert.equal(progress.body.data.report.resolvedAt, null);

        const res = await request(app).patch(`/api/v1/issue-reports/${id}`).set(authHeader(tpoA)).send({ status: "resolved", note: "Fixed in the latest build" });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.report.status, "resolved");
        assert.equal(res.body.data.report.note, "Fixed in the latest build");
        assert.ok(res.body.data.report.resolvedAt);
        const stored = await IssueReport.findById(id).lean();
        assert.equal(String(stored.handledBy), String(tpoA._id));
        assert.ok(stored.resolvedAt instanceof Date);

        const Notification = mongoose.models.Notification;
        if (Notification) {
            const updates = await Notification.find({ user: student._id, type: "issue.updated" }).sort({ createdAt: 1 }).lean();
            assert.deepEqual(updates.map((notification) => notification.title), [
                "Your issue report is now In progress",
                "Your issue report is now Resolved",
            ]);
            assert.equal(updates[1].body, "Fixed in the latest build");
        }

        const list = await request(app).get("/api/v1/issue-reports?status=resolved").set(authHeader(tpoA));
        assert.equal(list.body.data.total, 1);
        assert.equal(list.body.data.counts.resolved, 1);
    });

    it("rate limits anonymous reports per IP", async () => {
        process.env.ENABLE_RATE_LIMIT_IN_TESTS = "true";
        for (let index = 0; index < 10; index += 1) {
            const res = await submit({ name: `Visitor ${index}`, email: `v${index}@example.com`, description: `issue ${index}` });
            assert.equal(res.status, 201, `attempt ${index + 1}`);
        }
        const blocked = await submit({ name: "Visitor 11", email: "v11@example.com", description: "issue 11" });
        assert.equal(blocked.status, 429);
        assert.equal(codeOf(blocked), "TOO_MANY_ATTEMPTS");
    });

    it("files a report through the issue_report_create tool", async () => {
        const tool = tools.find((entry) => entry.name === "issue_report_create");
        assert.equal(tool.confirm, true);
        assert.deepEqual(tool.roles.sort(), ["admin", "alumni", "company", "student", "teacher", "tpo"]);
        const ctx = { user: student, role: "student", requestId: "r", sessionId: "s", now: new Date(), timezone: "Asia/Kolkata" };
        const preview = await tool.preview({ description: "The schedule shows the wrong room" }, ctx);
        assert.equal(preview.summary, "File this issue report for the placement team? 'The schedule shows the wrong room'");
        const result = await tool.handler({ description: "The schedule shows the wrong room", page: "schedule" }, ctx);
        const report = await IssueReport.findById(result.data.id).lean();
        assert.equal(String(report.user), String(student._id));
        assert.equal(report.email, "asha@demo.edu");
        assert.equal(report.page, "schedule");
        assert.equal(result.summary, `Filed your issue report #${result.data.id.slice(-6)}. The placement team will review it.`);

        // Also through the copilot endpoint (when agent-tools is mounted).
        const execute = (body) => request(app).post("/api/v1/agent-tools/execute").set("Authorization", `Bearer ${agentToolToken(student)}`).send(body);
        const pending = await execute({ tool: "issue_report_create", args: { description: "Chat issue" } });
        if (pending.status === 404) return;
        assert.equal(pending.body.data.needs_confirmation, true);
        const done = await execute({ tool: "issue_report_create", args: pending.body.data.args, confirmed: true });
        assert.equal(done.body.data.ok, true, JSON.stringify(done.body));
    });
});
