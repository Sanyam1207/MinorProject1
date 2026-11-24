// Acceptance tests for docs/contracts/AUTH-FACULTY.md §7, §8, §10.1 / §17 faculty.test.js:
// faculty + recruiter provisioning, scoping, deactivation, resets, one-time
// reveal, copilot tools and colleges.
import { connectTestDb, disconnectTestDb, createUser, authHeader, agentToolToken, getApp } from "./helpers.js";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";

process.env.TPO_EMAIL = "tpo@demo.edu";
process.env.TPO_INITIAL_PASSWORD = "Init-Pass-123";
process.env.TEACHER_EMAILS = "new.teacher@demo.edu,far.teacher@unknown.org";
process.env.CLIENT_ID = "";
process.env.ENABLE_RATE_LIMIT_IN_TESTS = "false";

const unique = () => crypto.randomBytes(3).toString("hex");

describe("faculty and recruiter provisioning (AUTH-FACULTY §7)", () => {
    let app;
    let mongoose;
    let User;
    let College;
    let Company;
    let accountMailer;
    let tools;
    let collegeA;
    let collegeB;
    let tpoA;
    let tpoB;
    let admin;
    let student;
    let teacher;
    const originalMailer = {};

    before(async () => {
        await connectTestDb("faculty");
        app = await getApp();
        ({ default: mongoose } = await import("mongoose"));
        ({ User } = await import("../src/models/user.models.js"));
        ({ College } = await import("../src/models/college.models.js"));
        ({ Company } = await import("../src/models/company.models.js"));
        ({ accountMailer } = await import("../src/services/account-mail.service.js"));
        ({ default: tools } = await import("../src/modules/faculty/tools.js"));
        Object.assign(originalMailer, accountMailer);
        collegeA = await College.create({ name: "Demo Institute of Technology", domain: "demo.edu" });
        collegeB = await College.create({ name: "Other College", domain: "other.edu" });
        tpoA = await createUser({ role: "tpo", name: "Dr. Kavita Rao", email: "kavita@demo.edu", college: collegeA._id });
        tpoB = await createUser({ role: "tpo", name: "Other TPO", email: "tpo@other.edu", college: collegeB._id });
        await College.updateOne({ _id: collegeA._id }, { tpo: tpoA._id });
        admin = await createUser({ role: "admin", email: "admin@platform.io" });
        student = await createUser({ role: "student", email: `s.${unique()}@demo.edu`, college: collegeA._id });
        teacher = await createUser({ role: "teacher", email: `t.${unique()}@demo.edu`, college: collegeA._id });
    });
    after(disconnectTestDb);
    afterEach(() => Object.assign(accountMailer, originalMailer));

    const codeOf = (res) => res.body?.errors?.[0]?.code;
    const invite = (actor, body, path = "/api/v1/faculty") => request(app).post(path).set(authHeader(actor)).send(body);
    const login = (email, password) => request(app).post("/api/v1/auth/login-or-register").send({ email, password });
    const stubMailer = (behaviour = "ok") => {
        const sent = [];
        accountMailer.isConfigured = () => true;
        accountMailer.send = async (message) => {
            sent.push(message);
            if (behaviour === "throw") throw new Error("SMTP 550");
            return { messageId: "m" };
        };
        return sent;
    };
    const toolNamed = (name) => tools.find((tool) => tool.name === name);
    const ctxFor = (user) => ({ user, role: user.role, requestId: "r", sessionId: "s", now: new Date(), timezone: "Asia/Kolkata" });

    describe("invites", () => {
        it("returns a one-time temporary password when email is off", async () => {
            const email = `anita.${unique()}@demo.edu`;
            const res = await invite(tpoA, { name: "Dr. Anita Sharma", email, department: "computer science", designation: "Associate Professor", employeeId: "DIT-F-104" });
            assert.equal(res.status, 201, JSON.stringify(res.body));
            const { data } = res.body;
            assert.equal(data.delivery, "manual");
            assert.equal(typeof data.temporaryPassword, "string");
            assert.ok(data.temporaryPassword.length >= 12);
            assert.equal(data.user.role, "teacher");
            assert.equal(data.user.department, "CSE");
            assert.equal(data.user.mustChangePassword, true);
            assert.ok(data.user.inviteExpiresAt);
            assert.equal(data.user.invitedBy.name, "Dr. Kavita Rao");
            assert.equal(data.user.college.domain, "demo.edu");
            assert.equal(data.user.isActive, true);

            const stored = await User.findById(data.user._id);
            assert.notEqual(stored.password, data.temporaryPassword);
            assert.ok(await stored.isPasswordCorrect(data.temporaryPassword));

            const signedIn = await login(email, data.temporaryPassword);
            assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
            assert.equal(signedIn.body.data.user.mustChangePassword, true);
            assert.equal(signedIn.body.data.user.role, "teacher");

            const one = await request(app).get(`/api/v1/faculty/${data.user._id}`).set(authHeader(tpoA));
            assert.equal(one.status, 200);
            assert.ok(!JSON.stringify(one.body).includes(data.temporaryPassword));
            assert.ok(one.body.data.user.lastLoginAt);
            const list = await request(app).get("/api/v1/faculty").set(authHeader(tpoA));
            assert.ok(!JSON.stringify(list.body).includes(data.temporaryPassword));
            assert.ok(!JSON.stringify(list.body).includes("\"password\""));

            if (mongoose.models.Notification) {
                const welcome = await mongoose.models.Notification.findOne({ user: data.user._id, type: "system" }).lean();
                assert.ok(welcome, "welcome notification");
                assert.match(welcome.body, /Dr\. Kavita Rao added you as faculty in CSE/);
                assert.equal(welcome.ui.panel, "teacher.schedule");
            }
        });

        it("emails the password when the mailer works and falls back to manual on failure", async () => {
            const sent = stubMailer();
            const email = `mailed.${unique()}@demo.edu`;
            const res = await invite(tpoA, { name: "Mailed Teacher", email });
            assert.equal(res.status, 201, JSON.stringify(res.body));
            assert.equal(res.body.data.delivery, "email");
            assert.equal(res.body.data.temporaryPassword, undefined);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].to, email);
            const temp = /Temporary password: (\S+)/.exec(sent[0].text)?.[1];
            assert.ok(temp && temp.length >= 12);
            assert.ok(sent[0].text.includes(process.env.FRONTEND_URL));
            assert.ok(!JSON.stringify(res.body).includes(temp));
            assert.equal((await login(email, temp)).status, 200);

            stubMailer("throw");
            const failed = await invite(tpoA, { name: "Unlucky Teacher", email: `unlucky.${unique()}@demo.edu` });
            assert.equal(failed.status, 201);
            assert.equal(failed.body.data.delivery, "manual");
            assert.ok(failed.body.data.temporaryPassword);
            assert.equal(failed.body.data.emailError, "Could not send the invite email");

            stubMailer();
            const optedOut = await invite(tpoA, { name: "No Email", email: `noemail.${unique()}@demo.edu`, sendEmail: false });
            assert.equal(optedOut.body.data.delivery, "manual");
            assert.ok(optedOut.body.data.temporaryPassword);
        });

        it("refuses duplicates, the reserved TPO email and bad input", async () => {
            const dup = await invite(tpoA, { name: "Copy Cat", email: student.email });
            assert.equal(dup.status, 409);
            assert.equal(codeOf(dup), "EMAIL_EXISTS");
            assert.equal(dup.body.errors[0].existingRole, "student");
            assert.equal(dup.body.errors[0].existingActive, true);
            assert.equal((await User.findById(student._id)).role, "student", "roles are never converted");

            const reserved = await invite(tpoA, { name: "Fake TPO", email: "TPO@demo.edu" });
            assert.equal(reserved.status, 409);
            assert.equal(codeOf(reserved), "EMAIL_RESERVED");

            for (const [body, field] of [
                [{ name: "A", email: `a.${unique()}@demo.edu` }, "name"],
                [{ name: "Good Name", email: "not-an-email" }, "email"],
                [{ name: "Good Name", email: `b.${unique()}@demo.edu`, department: "x".repeat(61) }, "department"],
                [{ name: "Good Name", email: `c.${unique()}@demo.edu`, employeeId: "x".repeat(41) }, "employeeId"],
            ]) {
                const res = await invite(tpoA, body);
                assert.equal(res.status, 400, JSON.stringify(res.body));
                assert.equal(codeOf(res), "VALIDATION");
                assert.equal(res.body.errors[0].field, field);
            }
        });

        it("is TPO/admin only and scoped to a college", async () => {
            for (const actor of [student, teacher]) {
                const res = await invite(actor, { name: "Nope Nope", email: `nope.${unique()}@demo.edu` });
                assert.equal(res.status, 403);
                assert.equal(codeOf(res), "FORBIDDEN");
                assert.equal((await request(app).get("/api/v1/faculty").set(authHeader(actor))).status, 403);
            }
            const noCollege = await invite(admin, { name: "Admin Invite", email: `ad.${unique()}@demo.edu` });
            assert.equal(noCollege.status, 400);
            assert.equal(codeOf(noCollege), "COLLEGE_REQUIRED");
            const withCollege = await invite(admin, { name: "Admin Invite", email: `ad2.${unique()}@other.edu`, collegeId: String(collegeB._id) });
            assert.equal(withCollege.status, 201, JSON.stringify(withCollege.body));
            assert.equal(withCollege.body.data.user.college.domain, "other.edu");
            const badCollege = await invite(admin, { name: "Admin Invite", email: `ad3.${unique()}@x.edu`, collegeId: String(new mongoose.Types.ObjectId()) });
            assert.equal(badCollege.status, 404);

            const unlinked = await createUser({ role: "tpo", email: `unlinked.${unique()}@nowhere.edu` });
            const noCol = await invite(unlinked, { name: "Some One", email: `so.${unique()}@demo.edu` });
            assert.equal(noCol.status, 409);
            assert.equal(codeOf(noCol), "NO_COLLEGE");
        });

        it("hides other colleges' teachers behind 404", async () => {
            const target = await createUser({ role: "teacher", email: `scoped.${unique()}@demo.edu`, college: collegeA._id });
            const headers = authHeader(tpoB);
            assert.equal(codeOf(await request(app).get(`/api/v1/faculty/${target._id}`).set(headers)), "NOT_FOUND");
            assert.equal(codeOf(await request(app).patch(`/api/v1/faculty/${target._id}`).set(headers).send({ name: "Hijacked" })), "NOT_FOUND");
            assert.equal(codeOf(await request(app).delete(`/api/v1/faculty/${target._id}`).set(headers)), "NOT_FOUND");
            assert.equal(codeOf(await request(app).post(`/api/v1/faculty/${target._id}/reset-password`).set(headers).send({})), "NOT_FOUND");
            assert.equal((await User.findById(target._id)).isActive, true);
            // A student id is not a faculty account either.
            assert.equal(codeOf(await request(app).get(`/api/v1/faculty/${student._id}`).set(authHeader(tpoA))), "NOT_FOUND");
            assert.equal(codeOf(await request(app).get("/api/v1/faculty/not-an-id").set(authHeader(tpoA))), "NOT_FOUND");
            // Admin sees it with or without collegeId.
            assert.equal((await request(app).get(`/api/v1/faculty/${target._id}`).set(authHeader(admin))).status, 200);
            assert.equal((await request(app).get(`/api/v1/faculty/${target._id}?collegeId=${collegeB._id}`).set(authHeader(admin))).status, 404);
        });
    });

    describe("lifecycle", () => {
        it("deactivates, revokes access and reactivates", async () => {
            const created = await invite(tpoA, { name: "Lifecycle Teacher", email: `life.${unique()}@demo.edu` });
            const { user, temporaryPassword } = created.body.data;
            const signed = await login(user.email, temporaryPassword);
            const oldToken = signed.body.data.accessToken;

            const off = await request(app).delete(`/api/v1/faculty/${user._id}`).set(authHeader(tpoA));
            assert.equal(off.status, 200, JSON.stringify(off.body));
            assert.equal(off.body.data.user.isActive, false);
            assert.ok(off.body.data.user.deactivatedAt);
            const blocked = await login(user.email, temporaryPassword);
            assert.equal(blocked.status, 403);
            assert.equal(codeOf(blocked), "ACCOUNT_DISABLED");
            const old = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${oldToken}`);
            assert.equal(old.status, 401);
            assert.equal(codeOf(old), "ACCOUNT_DISABLED");
            const reset = await request(app).post(`/api/v1/faculty/${user._id}/reset-password`).set(authHeader(tpoA)).send({});
            assert.equal(reset.status, 409);
            assert.equal(codeOf(reset), "ACCOUNT_INACTIVE");

            const on = await request(app).patch(`/api/v1/faculty/${user._id}`).set(authHeader(tpoA)).send({ isActive: true });
            assert.equal(on.status, 200);
            assert.equal(on.body.data.user.isActive, true);
            assert.equal(on.body.data.user.deactivatedAt, null);
            assert.equal((await login(user.email, temporaryPassword)).status, 200);
            assert.equal(codeOf(await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${oldToken}`)), "SESSION_REVOKED");

            // PATCH {isActive:false} deactivates as well.
            const patchOff = await request(app).patch(`/api/v1/faculty/${user._id}`).set(authHeader(tpoA)).send({ isActive: false, designation: "Lecturer" });
            assert.equal(patchOff.body.data.user.isActive, false);
            assert.equal(patchOff.body.data.user.designation, "Lecturer");
            assert.equal(codeOf(await login(user.email, temporaryPassword)), "ACCOUNT_DISABLED");
        });

        it("updates profile fields but never email or role", async () => {
            const created = await invite(tpoA, { name: "Patch Teacher", email: `patch.${unique()}@demo.edu` });
            const id = created.body.data.user._id;
            const res = await request(app).patch(`/api/v1/faculty/${id}`).set(authHeader(tpoA))
                .send({ name: "Patched Teacher", department: "Information Technology", employeeId: "E-1" });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.user.name, "Patched Teacher");
            assert.equal(res.body.data.user.department, "IT");
            assert.equal(res.body.data.user.employeeId, "E-1");
            const email = await request(app).patch(`/api/v1/faculty/${id}`).set(authHeader(tpoA)).send({ email: "x@demo.edu" });
            assert.equal(codeOf(email), "VALIDATION");
            assert.match(email.body.message, /email and role cannot be changed/);
            assert.equal(codeOf(await request(app).patch(`/api/v1/faculty/${id}`).set(authHeader(tpoA)).send({ role: "tpo" })), "VALIDATION");
            assert.equal(codeOf(await request(app).patch(`/api/v1/faculty/${id}`).set(authHeader(tpoA)).send({})), "VALIDATION");
        });

        it("resets a password: new temporary works, old fails, sessions are revoked", async () => {
            const created = await invite(tpoA, { name: "Reset Teacher", email: `rst.${unique()}@demo.edu` });
            const { user, temporaryPassword } = created.body.data;
            const signed = await login(user.email, temporaryPassword);
            const cookie = (signed.headers["set-cookie"] || []).find((value) => value.startsWith("refreshToken=")).split(";")[0];

            const res = await request(app).post(`/api/v1/faculty/${user._id}/reset-password`).set(authHeader(tpoA)).send({});
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.delivery, "manual");
            const fresh = res.body.data.temporaryPassword;
            assert.ok(fresh && fresh !== temporaryPassword);
            assert.equal(res.body.data.user.mustChangePassword, true);
            assert.equal((await login(user.email, temporaryPassword)).status, 401);
            assert.equal((await login(user.email, fresh)).status, 200);
            assert.equal((await request(app).post("/api/v1/auth/refresh-token").set("Cookie", cookie)).status, 401);
            assert.equal(codeOf(await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${signed.body.data.accessToken}`)), "SESSION_REVOKED");
        });
    });

    describe("listing", () => {
        it("filters, paginates and counts within the college", async () => {
            const college = await College.create({ name: "List College", domain: `list-${unique()}.edu` });
            const listTpo = await createUser({ role: "tpo", email: `ltpo@${college.domain}`, college: college._id });
            const rows = [
                ["Alice Kumar", "CSE", true], ["Bob Mehta", "CSE", true], ["Carol Das", "IT", true],
                ["Dev Rao", "IT", false], ["Esha Pal", "ECE", true],
            ];
            for (const [name, department, isActive] of rows) {
                await createUser({ role: "teacher", name, department, isActive, email: `${name.split(" ")[0].toLowerCase()}@${college.domain}`, college: college._id });
            }
            await createUser({ role: "teacher", name: "Elsewhere", email: `e.${unique()}@demo.edu`, college: collegeA._id });
            const list = (query) => request(app).get(`/api/v1/faculty${query}`).set(authHeader(listTpo));

            const all = await list("");
            assert.equal(all.status, 200);
            assert.equal(all.body.data.total, 5);
            assert.equal(all.body.data.page, 1);
            assert.equal(all.body.data.limit, 50);
            assert.equal(all.body.data.items.at(-1).name, "Dev Rao", "inactive accounts sort last");
            assert.deepEqual(Object.keys(all.body.data.items[0]).sort(), [
                "_id", "authProvider", "college", "deactivatedAt", "department", "designation", "email", "employeeId",
                "inviteExpiresAt", "invitedAt", "invitedBy", "isActive", "lastLoginAt", "mustChangePassword", "name", "role",
                ...(mongoose.models.Course ? ["courseCount"] : []),
            ].sort());

            const cse = await list("?department=computer%20science");
            assert.equal(cse.body.data.total, 2);
            assert.equal((await list("?status=inactive")).body.data.total, 1);
            assert.equal((await list("?status=active")).body.data.total, 4);
            assert.equal(codeOf(await list("?status=bogus")), "VALIDATION");
            const search = await list("?search=carol");
            assert.deepEqual(search.body.data.items.map((item) => item.name), ["Carol Das"]);
            const page2 = await list("?limit=2&page=2");
            assert.equal(page2.body.data.items.length, 2);
            assert.equal(page2.body.data.total, 5);
            assert.equal(page2.body.data.limit, 2);
            assert.equal((await list("?limit=500")).body.data.limit, 100);

            const adminAll = await request(app).get(`/api/v1/faculty?collegeId=${college._id}`).set(authHeader(admin));
            assert.equal(adminAll.body.data.total, 5);

            const Course = mongoose.models.Course;
            if (Course) {
                const alice = all.body.data.items.find((item) => item.name === "Alice Kumar");
                const teacherId = new mongoose.Types.ObjectId(alice._id);
                await Course.collection.insertMany(["active", "active", "archived"].map((status, index) => ({
                    teacher: teacherId, code: `CS${index}`, name: `Course ${index}`, status, students: [],
                    joinCode: `T${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                })));
                const counted = await list("?search=alice");
                assert.equal(counted.body.data.items[0].courseCount, 2, "only active courses count");
                assert.equal((await list("?search=bob")).body.data.items[0].courseCount, 0);
            }
        });
    });

    describe("recruiters", () => {
        it("finds or creates the company case-insensitively", async () => {
            const name = `Acme Corp ${unique()}`;
            const first = await invite(tpoA, { name: "Rita Recruiter", email: `rita.${unique()}@acme.com`, companyName: name }, "/api/v1/recruiters");
            assert.equal(first.status, 201, JSON.stringify(first.body));
            const second = await invite(tpoA, { name: "Ravi Recruiter", email: `ravi.${unique()}@acme.com`, companyName: name.toLowerCase(), designation: "HR" }, "/api/v1/recruiters");
            assert.equal(second.status, 201, JSON.stringify(second.body));
            assert.equal(await Company.countDocuments({ name: { $regex: `^${name}$`, $options: "i" } }), 1);
            assert.equal(String(first.body.data.company._id), String(second.body.data.company._id));
            for (const res of [first, second]) {
                assert.equal(res.body.data.user.role, "company");
                assert.equal(res.body.data.user.company.name, name);
                assert.equal(res.body.data.user.college.domain, "demo.edu");
                assert.equal(res.body.data.delivery, "manual");
            }
            const stored = await User.findById(first.body.data.user._id);
            assert.equal(String(stored.company), String(first.body.data.company._id));
            const signed = await login(stored.email, first.body.data.temporaryPassword);
            assert.equal(signed.body.data.user.role, "company");

            const byId = await invite(tpoA, { name: "Id Recruiter", email: `id.${unique()}@acme.com`, companyId: String(first.body.data.company._id) }, "/api/v1/recruiters");
            assert.equal(byId.status, 201);
            const unknownId = await invite(tpoA, { name: "Lost Recruiter", email: `lost.${unique()}@acme.com`, companyId: String(new mongoose.Types.ObjectId()) }, "/api/v1/recruiters");
            assert.equal(unknownId.status, 404);
            const missing = await invite(tpoA, { name: "No Company", email: `nc.${unique()}@acme.com` }, "/api/v1/recruiters");
            assert.equal(missing.status, 400);
            assert.equal(codeOf(missing), "VALIDATION");
            const both = await invite(tpoA, { name: "Both Company", email: `bc.${unique()}@acme.com`, companyName: "X", companyId: String(first.body.data.company._id) }, "/api/v1/recruiters");
            assert.equal(codeOf(both), "VALIDATION");

            const list = await request(app).get(`/api/v1/recruiters?company=${encodeURIComponent(name.toLowerCase())}`).set(authHeader(tpoA));
            assert.equal(list.status, 200);
            assert.equal(list.body.data.total, 3);
            assert.ok(list.body.data.items.every((item) => item.role === "company" && item.company?.name === name));
            const byCompanyId = await request(app).get(`/api/v1/recruiters?company=${first.body.data.company._id}`).set(authHeader(tpoA));
            assert.equal(byCompanyId.body.data.total, 3);
            const toolList = await toolNamed("recruiters_list").handler({ company: String(first.body.data.company._id) }, ctxFor(tpoA));
            assert.equal(toolList.data.total, 3);
            assert.match(toolList.summary, new RegExp(`^3 recruiters at Demo Institute of Technology \\(3 active\\): ${name} 3\\.`));
            assert.equal(codeOf(await request(app).get(`/api/v1/recruiters/${first.body.data.user._id}`).set(authHeader(tpoB))), "NOT_FOUND");
            // A recruiter id is not a faculty id.
            assert.equal(codeOf(await request(app).get(`/api/v1/faculty/${first.body.data.user._id}`).set(authHeader(tpoA))), "NOT_FOUND");

            const moved = await request(app).patch(`/api/v1/recruiters/${first.body.data.user._id}`).set(authHeader(tpoA)).send({ companyName: `Beta ${unique()}` });
            assert.equal(moved.status, 200, JSON.stringify(moved.body));
            assert.match(moved.body.data.user.company.name, /^Beta /);

            if (mongoose.models.Notification) {
                const welcome = await mongoose.models.Notification.findOne({ user: first.body.data.user._id, type: "system" }).lean();
                assert.equal(welcome.ui.panel, "company.drives");
                assert.match(welcome.body, /invited you to recruit at Demo Institute of Technology/);
            }
        });
    });

    describe("copilot tools", () => {
        it("lists faculty with a summary and the Faculty panel", async () => {
            const result = await toolNamed("faculty_list").handler({ status: "all" }, ctxFor(tpoA));
            assert.equal(result.ui.panel, "tpo.faculty");
            assert.ok(Array.isArray(result.data.items));
            assert.equal(typeof result.data.total, "number");
            assert.match(result.summary, /faculty at Demo Institute of Technology \(\d+ active\)/);
            for (const item of result.data.items) {
                assert.deepEqual(Object.keys(item).sort(), ["courseCount", "department", "designation", "email", "id", "isActive", "name"]);
            }
            const recruiters = await toolNamed("recruiters_list").handler({}, ctxFor(tpoA));
            assert.equal(recruiters.ui.panel, "tpo.recruiters");
        });

        it("previews without side effects and invites without leaking the password", async () => {
            const email = `tool.${unique()}@demo.edu`;
            const invitation = toolNamed("faculty_invite");
            assert.equal(invitation.confirm, true);
            const preview = await invitation.preview({ name: "Tool Teacher", email, department: "cse" }, ctxFor(tpoA));
            assert.equal(preview.summary, `Invite **Tool Teacher** (${email}) as CSE faculty? You will see a one-time temporary password in the Faculty panel.`);
            assert.deepEqual(preview.args, { name: "Tool Teacher", email, department: "CSE" });
            assert.equal(await User.countDocuments({ email }), 0, "preview creates nothing");
            await assert.rejects(
                invitation.preview({ name: "Dup", email: student.email }, ctxFor(tpoA)),
                (error) => error.errors?.[0]?.code === "EMAIL_EXISTS",
            );

            const result = await invitation.handler({ name: "Tool Teacher", email, department: "cse" }, ctxFor(tpoA));
            const created = await User.findOne({ email });
            assert.ok(created);
            assert.equal(created.role, "teacher");
            assert.equal(result.ui.panel, "tpo.faculty");
            assert.equal(result.ui.params.highlightId, String(created._id));
            assert.equal(result.data.delivery, "manual");
            const { revealId } = result.ui.params;
            assert.ok(revealId);
            assert.match(result.summary, /Open the Faculty panel to copy the one-time temporary password \(valid 10 minutes\)/);

            // Another TPO cannot redeem it and does not consume it.
            const stranger = await request(app).post("/api/v1/faculty/reveal").set(authHeader(tpoB)).send({ revealId });
            assert.equal(stranger.status, 404);
            assert.equal(codeOf(stranger), "REVEAL_EXPIRED");
            const reveal = await request(app).post("/api/v1/faculty/reveal").set(authHeader(tpoA)).send({ revealId });
            assert.equal(reveal.status, 200, JSON.stringify(reveal.body));
            assert.equal(reveal.body.data.email, email);
            const password = reveal.body.data.temporaryPassword;
            assert.ok(password.length >= 12);
            assert.ok(!JSON.stringify(result).includes(password), "the tool result never contains the password");
            assert.ok(!JSON.stringify(preview).includes(password));
            assert.equal((await login(email, password)).status, 200);
            const second = await request(app).post("/api/v1/faculty/reveal").set(authHeader(tpoA)).send({ revealId });
            assert.equal(second.status, 404);
            assert.equal(codeOf(second), "REVEAL_EXPIRED");
        });

        it("emails instead of revealing when the mailer works", async () => {
            const sent = stubMailer();
            const preview = await toolNamed("faculty_invite").preview({ name: "Mail Tool", email: `mt.${unique()}@demo.edu` }, ctxFor(tpoA));
            assert.match(preview.summary, /Login details will be emailed\.$/);
            const email = `mt2.${unique()}@demo.edu`;
            const result = await toolNamed("faculty_invite").handler({ name: "Mail Tool", email }, ctxFor(tpoA));
            assert.equal(result.data.delivery, "email");
            assert.equal(result.ui.params.revealId, undefined);
            assert.match(result.summary, new RegExp(`Login details were emailed to ${email.replace(/\./g, "\\.")}`));
            const temp = /Temporary password: (\S+)/.exec(sent.at(-1).text)[1];
            assert.ok(!JSON.stringify(result).includes(temp));
        });

        it("invites recruiters through the tool", async () => {
            const email = `rtool.${unique()}@acme.com`;
            const company = `Tool Co ${unique()}`;
            const tool = toolNamed("recruiter_invite");
            const preview = await tool.preview({ name: "Tool Recruiter", email, company }, ctxFor(tpoA));
            assert.deepEqual(preview.args, { name: "Tool Recruiter", email, company });
            assert.equal(await Company.countDocuments({ name: company }), 0, "preview creates no company");
            const result = await tool.handler({ name: "Tool Recruiter", email, company }, ctxFor(tpoA));
            assert.equal(result.ui.panel, "tpo.recruiters");
            assert.ok(result.ui.params.revealId);
            assert.equal(result.ui.params.revealInviteId, result.ui.params.revealId);
            assert.equal(result.data.recruiter.company, company);
            assert.equal((await User.findOne({ email })).role, "company");
        });

        it("asks a college-less admin to use the panel", async () => {
            await assert.rejects(
                toolNamed("faculty_invite").handler({ name: "Admin Tool", email: `at.${unique()}@demo.edu` }, ctxFor(admin)),
                (error) => error.errors?.[0]?.code === "COLLEGE_REQUIRED",
            );
        });

        it("keeps faculty tools out of a student's manifest", async () => {
            const student = await createUser({ role: "student", email: `man.${unique()}@demo.edu` });
            const res = await request(app).get("/api/v1/agent-tools/manifest").set("Authorization", `Bearer ${agentToolToken(student)}`);
            if (res.status === 404) return; // agent-tools not mounted
            assert.equal(res.status, 200);
            const names = res.body.data.tools.map((tool) => tool.name);
            for (const name of ["faculty_invite", "faculty_list", "recruiter_invite", "recruiters_list"]) assert.ok(!names.includes(name), name);
            assert.ok(names.includes("issue_report_create"));
            const tpoManifest = await request(app).get("/api/v1/agent-tools/manifest").set("Authorization", `Bearer ${agentToolToken(tpoA)}`);
            const tpoNames = tpoManifest.body.data.tools.map((tool) => tool.name);
            for (const name of ["faculty_invite", "faculty_list", "recruiter_invite", "recruiters_list"]) assert.ok(tpoNames.includes(name), name);

            // Through /execute: confirmation first, then the real invite.
            const email = `exec.${unique()}@demo.edu`;
            const execute = (body) => request(app).post("/api/v1/agent-tools/execute").set("Authorization", `Bearer ${agentToolToken(tpoA)}`).send(body);
            const pending = await execute({ tool: "faculty_invite", args: { name: "Exec Teacher", email } });
            assert.equal(pending.body.data.needs_confirmation, true, JSON.stringify(pending.body));
            assert.match(pending.body.data.preview, /Invite \*\*Exec Teacher\*\*/);
            const done = await execute({ tool: "faculty_invite", args: pending.body.data.args, confirmed: true });
            assert.equal(done.body.data.ok, true, JSON.stringify(done.body));
            assert.equal(done.body.data.ui.panel, "tpo.faculty");
            const duplicate = await execute({ tool: "faculty_invite", args: { name: "Exec Teacher", email } });
            assert.equal(duplicate.body.data.error, "EMAIL_EXISTS");
        });
    });

    describe("colleges", () => {
        it("lets the TPO edit their college and canonicalises lists", async () => {
            const res = await request(app).patch("/api/v1/colleges/mine").set(authHeader(tpoA))
                .send({ branches: ["computer science", "IT", "cse"], departments: ["CSE", "Training & Placement"] });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.data.college.branches, ["CSE", "IT"]);
            assert.deepEqual(res.body.data.college.departments, ["CSE", "Training & Placement"]);
            assert.deepEqual((await College.findById(collegeA._id)).branches, ["CSE", "IT"]);
            assert.equal(codeOf(await request(app).patch("/api/v1/colleges/mine").set(authHeader(tpoA)).send({ name: "X" })), "VALIDATION");
            assert.equal((await request(app).patch("/api/v1/colleges/mine").set(authHeader(student)).send({ name: "Hacked" })).status, 403);
        });

        it("shows any member their college", async () => {
            const res = await request(app).get("/api/v1/colleges/mine").set(authHeader(student));
            assert.equal(res.status, 200);
            assert.equal(res.body.data.college.domain, "demo.edu");
            assert.equal(res.body.data.college.tpo.name, "Dr. Kavita Rao");
            const outsider = await createUser({ role: "alumni", email: `alum.${unique()}@gmail.com` });
            assert.equal(codeOf(await request(app).get("/api/v1/colleges/mine").set(authHeader(outsider))), "NOT_FOUND");
        });

        it("keeps college creation admin-only", async () => {
            const byTpo = await request(app).post("/api/v1/colleges").set(authHeader(tpoA)).send({ name: "New College", domain: "new.edu" });
            assert.equal(byTpo.status, 403);
            assert.equal(codeOf(byTpo), "FORBIDDEN");
            assert.equal((await request(app).get("/api/v1/colleges").set(authHeader(tpoA))).status, 403);
            const created = await request(app).post("/api/v1/colleges").set(authHeader(admin))
                .send({ name: "New College", domain: "New.EDU", branches: ["mechanical engineering"] });
            assert.equal(created.status, 201, JSON.stringify(created.body));
            assert.equal(created.body.data.college.domain, "new.edu");
            assert.deepEqual(created.body.data.college.branches, ["ME"]);
            const dup = await request(app).post("/api/v1/colleges").set(authHeader(admin)).send({ name: "Again", domain: "new.edu" });
            assert.equal(dup.status, 409);
            assert.equal(codeOf(dup), "DUPLICATE");
            assert.equal(codeOf(await request(app).post("/api/v1/colleges").set(authHeader(admin)).send({ name: "Bad", domain: "nodot" })), "VALIDATION");
            const all = await request(app).get("/api/v1/colleges").set(authHeader(admin));
            assert.ok(all.body.data.items.some((college) => college.domain === "new.edu"));
        });
    });
});

describe("canonicalBranch (AUTH-FACULTY §6.3)", () => {
    it("maps common spellings to short codes and keeps the rest", async () => {
        const { canonicalBranch, canonicalBranchList } = await import("../src/utils/branch.js");
        const cases = [
            ["BACHELOR OF TECHNOLOGY (COMPUTER SCIENCE AND ENGINEERING)", "CSE"],
            ["Artificial Intelligence & Machine Learning", "AIML"],
            ["AI-DS", "AIDS"],
            ["Information Technology", "IT"],
            ["it", "IT"],
            ["Electronics & Communication Engineering", "ECE"],
            ["Electrical and Electronics Engineering", "EEE"],
            ["Electrical Engineering", "EE"],
            ["Mech", "ME"],
            ["Civil Engineering", "CE"],
            ["Training & Placement", "Training & Placement"],
            ["  ", ""],
            [null, ""],
        ];
        for (const [input, expected] of cases) assert.equal(canonicalBranch(input), expected, String(input));
        assert.equal(canonicalBranch("x".repeat(80)).length, 60);
        assert.deepEqual(canonicalBranchList(["cse", "Computer Science", "IT", ""]), ["CSE", "IT"]);
    });
});
