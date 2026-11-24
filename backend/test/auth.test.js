// Acceptance tests for docs/contracts/AUTH-FACULTY.md §17 auth.test.js:
// stored-role login, registration policy, sessions, revocation, reset/change
// password, profile rules, rate limits, sockets, options, GGSIPU guard.
import { connectTestDb, disconnectTestDb, createUser, authHeader, getApp, startTestServer, sleep } from "./helpers.js";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import { io as ioClient } from "socket.io-client";

// config.js reads env once on import (dotenv never overrides keys already set).
process.env.TPO_EMAIL = "tpo@demo.edu";
process.env.TPO_INITIAL_PASSWORD = "Init-Pass-123";
process.env.TEACHER_EMAILS = "new.teacher@demo.edu,far.teacher@unknown.org";
process.env.CLIENT_ID = "";
process.env.GOOGLE_REQUIRE_HOSTED_DOMAIN = "false";
process.env.AUTH_COOKIE_SAMESITE = "strict";
process.env.ENABLE_RATE_LIMIT_IN_TESTS = "false";

const PASSWORD = "Passw0rd!";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const unique = () => crypto.randomBytes(3).toString("hex");

describe("auth (AUTH-FACULTY §4–§6)", () => {
    let app;
    let User;
    let College;
    let AuthSession;
    let mongoose;
    let accountMailer;
    let demoCollege;
    const originalMailer = {};

    before(async () => {
        await connectTestDb("auth");
        app = await getApp();
        ({ default: mongoose } = await import("mongoose"));
        ({ User } = await import("../src/models/user.models.js"));
        ({ College } = await import("../src/models/college.models.js"));
        ({ AuthSession } = await import("../src/models/auth-session.models.js"));
        ({ accountMailer } = await import("../src/services/account-mail.service.js"));
        Object.assign(originalMailer, accountMailer);
        demoCollege = await College.create({ name: "Demo Institute of Technology", domain: "demo.edu" });
    });
    after(disconnectTestDb);
    afterEach(() => {
        Object.assign(accountMailer, originalMailer);
        process.env.ENABLE_RATE_LIMIT_IN_TESTS = "false";
    });

    const login = (body) => request(app).post("/api/v1/auth/login-or-register").send(body);
    const refreshCookieOf = (res) => {
        const cookies = res.headers["set-cookie"] || [];
        const match = cookies.find((cookie) => /^refreshToken=[^;]+;/.test(cookie) && cookie.includes("Path=/api/v1/auth"));
        return match ? match.split(";")[0] : null;
    };
    const refresh = (cookie) => request(app).post("/api/v1/auth/refresh-token").set("Cookie", cookie).send({});
    const me = (token) => request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    const codeOf = (res) => res.body?.errors?.[0]?.code;
    const stubMailer = () => {
        const sent = [];
        accountMailer.isConfigured = () => true;
        accountMailer.send = async (message) => {
            sent.push(message);
            return { messageId: `m-${sent.length}` };
        };
        return sent;
    };
    const signIn = async (email, password = PASSWORD) => {
        const res = await login({ email, password });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return { res, token: res.body.data.accessToken, cookie: refreshCookieOf(res), user: res.body.data.user };
    };

    describe("registration and sign-in", () => {
        it("registers a new student on a college domain with an httpOnly refresh cookie", async () => {
            const email = `stu.${unique()}@demo.edu`;
            const res = await login({ email, password: "Str0ng-pass", role: "student" });
            assert.equal(res.status, 201, JSON.stringify(res.body));
            const { data } = res.body;
            assert.equal(data.user.role, "student");
            assert.equal(data.isNewUser, true);
            assert.equal(data.roleAdjusted, false);
            assert.ok(data.accessToken);
            assert.equal(data.refreshToken, undefined);
            assert.ok(!JSON.stringify(res.body).includes("refreshToken"));
            const cookie = (res.headers["set-cookie"] || []).find((value) => value.startsWith("refreshToken="));
            assert.match(cookie, /^refreshToken=[^;]+;/);
            assert.match(cookie, /Path=\/api\/v1\/auth/);
            assert.match(cookie, /HttpOnly/);
            assert.equal(String(data.user.college), String(demoCollege._id));
            assert.equal(data.user.collegeName, "Demo Institute of Technology");
            const student = await mongoose.models.Student.findOne({ email });
            assert.ok(student, "a SIH Student document is linked");
            const stored = await User.findOne({ email });
            assert.equal(String(stored.student), String(student._id));
            assert.ok(stored.lastLoginAt instanceof Date);
        });

        it("rejects an unknown domain without creating a user", async () => {
            const email = `someone.${unique()}@nowhere.org`;
            const res = await login({ email, password: "Str0ng-pass" });
            assert.equal(res.status, 400);
            assert.equal(codeOf(res), "INVALID_DOMAIN");
            assert.equal(await User.countDocuments({ email }), 0);
        });

        it("validates the email and password inputs", async () => {
            assert.equal(codeOf(await login({ email: "not-an-email", password: "x" })), "VALIDATION");
            assert.equal(codeOf(await login({ email: `a.${unique()}@demo.edu` })), "VALIDATION");
        });

        it("signs existing users in with their STORED role", async () => {
            const teacher = await createUser({ role: "teacher", email: `teach.${unique()}@demo.edu`, college: demoCollege._id });
            const res = await login({ email: teacher.email, password: PASSWORD, role: "student" });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.user.role, "teacher");
            assert.equal(res.body.data.roleAdjusted, true);
            assert.equal(res.body.data.isNewUser, false);

            // A second TPO of a college whose slot is taken still signs in (no 409).
            const second = await College.create({ name: "Second College", domain: `second-${unique()}.edu` });
            const holder = await createUser({ role: "tpo", email: `holder@${second.domain}`, college: second._id });
            await College.updateOne({ _id: second._id }, { tpo: holder._id });
            const other = await createUser({ role: "tpo", email: `other@${second.domain}`, college: second._id });
            const tpoRes = await login({ email: other.email, password: PASSWORD, role: "tpo" });
            assert.equal(tpoRes.status, 200, JSON.stringify(tpoRes.body));
            assert.equal(tpoRes.body.data.user.role, "tpo");
            assert.equal(tpoRes.body.data.roleAdjusted, false);
        });

        it("registers TEACHER_EMAILS as teachers on a registered college domain only", async () => {
            const res = await login({ email: "new.teacher@demo.edu", password: "Str0ng-pass", role: "student" });
            assert.equal(res.status, 201, JSON.stringify(res.body));
            assert.equal(res.body.data.user.role, "teacher");
            assert.equal(res.body.data.roleAdjusted, true);
            assert.equal(String(res.body.data.user.college), String(demoCollege._id));

            const far = await login({ email: "far.teacher@unknown.org", password: "Str0ng-pass" });
            assert.equal(far.status, 400);
            assert.equal(codeOf(far), "INVALID_DOMAIN");
        });

        it("refuses self-registration for invite-only and reserved roles", async () => {
            const cases = [
                ["teacher", 403, "TEACHER_INVITE_REQUIRED"],
                ["faculty", 403, "TEACHER_INVITE_REQUIRED"],
                ["company", 403, "RECRUITER_INVITE_REQUIRED"],
                ["recruiter", 403, "RECRUITER_INVITE_REQUIRED"],
                ["admin", 403, "ROLE_NOT_ALLOWED"],
                ["tpo", 403, "TPO_NOT_APPROVED"],
            ];
            for (const [role, status, code] of cases) {
                const email = `self.${unique()}@demo.edu`;
                const res = await login({ email, password: "Str0ng-pass", role });
                assert.equal(res.status, status, `${role}: ${JSON.stringify(res.body)}`);
                assert.equal(codeOf(res), code, role);
                assert.equal(await User.countDocuments({ email }), 0, `${role} creates no user`);
            }
        });

        it("lets alumni register with any domain", async () => {
            const res = await login({ email: `alum.${unique()}@gmail.com`, password: "Str0ng-pass", role: "alumni" });
            assert.equal(res.status, 201);
            assert.equal(res.body.data.user.role, "alumni");
        });

        it("bootstraps the TPO only with TPO_EMAIL and TPO_INITIAL_PASSWORD", async () => {
            const wrong = await login({ email: "tpo@demo.edu", password: "Wrong-Pass-123", role: "tpo" });
            assert.equal(wrong.status, 403);
            assert.equal(codeOf(wrong), "TPO_NOT_APPROVED");
            const asStudent = await login({ email: "tpo@demo.edu", password: "Different-1", role: "student" });
            assert.equal(asStudent.status, 403);
            assert.equal(codeOf(asStudent), "TPO_NOT_APPROVED");
            assert.equal(await User.countDocuments({ email: "tpo@demo.edu" }), 0);

            const ok = await login({ email: "TPO@demo.edu ", password: "Init-Pass-123", role: "tpo" });
            assert.equal(ok.status, 201, JSON.stringify(ok.body));
            assert.equal(ok.body.data.user.role, "tpo");
            const college = await College.findById(demoCollege._id);
            assert.equal(String(college.tpo), String(ok.body.data.user._id));

            // Afterwards the TPO signs in normally.
            const again = await login({ email: "tpo@demo.edu", password: "Init-Pass-123" });
            assert.equal(again.status, 200);
            assert.equal(again.body.data.user.role, "tpo");
        });

        it("answers credential problems with specific codes", async () => {
            const user = await createUser({ email: `cred.${unique()}@demo.edu` });
            const wrong = await login({ email: user.email, password: "nope-nope" });
            assert.equal(wrong.status, 401);
            assert.equal(codeOf(wrong), "INVALID_CREDENTIALS");

            const weak = await login({ email: `weak.${unique()}@demo.edu`, password: "1234567" });
            assert.equal(weak.status, 400);
            assert.equal(codeOf(weak), "WEAK_PASSWORD");

            const googleOnly = await createUser({ email: `g.${unique()}@demo.edu`, password: undefined, authProvider: "google", googleId: "g-1" });
            const noPassword = await login({ email: googleOnly.email, password: "whatever-1" });
            assert.equal(noPassword.status, 400);
            assert.equal(codeOf(noPassword), "PASSWORD_NOT_SET");
        });

        it("rejects an expired temporary password", async () => {
            const teacher = await createUser({
                role: "teacher",
                email: `temp.${unique()}@demo.edu`,
                mustChangePassword: true,
                tempPasswordExpiresAt: new Date(Date.now() - 60_000),
            });
            const res = await login({ email: teacher.email, password: PASSWORD });
            assert.equal(res.status, 401);
            assert.equal(codeOf(res), "TEMP_PASSWORD_EXPIRED");
        });
    });

    describe("deactivation and sessions", () => {
        it("blocks a deactivated user at login, on old access tokens and on refresh", async () => {
            const user = await createUser({ email: `off.${unique()}@demo.edu` });
            const { token, cookie } = await signIn(user.email);
            await User.updateOne({ _id: user._id }, { isActive: false });

            const res = await login({ email: user.email, password: PASSWORD });
            assert.equal(res.status, 403);
            assert.equal(codeOf(res), "ACCOUNT_DISABLED");
            const meRes = await me(token);
            assert.equal(meRes.status, 401);
            assert.equal(codeOf(meRes), "ACCOUNT_DISABLED");
            const refreshRes = await refresh(cookie);
            assert.equal(refreshRes.status, 403);
            assert.equal(codeOf(refreshRes), "ACCOUNT_DISABLED");
        });

        it("refreshes without rotating the session", async () => {
            const user = await createUser({ email: `ref.${unique()}@demo.edu` });
            const { cookie } = await signIn(user.email);
            const first = await refresh(cookie);
            assert.equal(first.status, 200, JSON.stringify(first.body));
            assert.deepEqual(Object.keys(first.body.data), ["accessToken"]);
            assert.equal((await me(first.body.data.accessToken)).status, 200);
            assert.equal(refreshCookieOf(first), null, "the refresh cookie is not rotated");
            const second = await refresh(cookie);
            assert.equal(second.status, 200, "the same refresh cookie keeps working (several tabs)");
            const garbage = await refresh("refreshToken=not-a-jwt");
            assert.equal(garbage.status, 401);
            assert.equal(codeOf(garbage), "REFRESH_TOKEN_INVALID");
            const none = await request(app).post("/api/v1/auth/refresh-token").send({});
            assert.equal(codeOf(none), "REFRESH_TOKEN_INVALID");
        });

        it("logs out only the presented session, without an access token", async () => {
            const user = await createUser({ email: `two.${unique()}@demo.edu` });
            const a = await signIn(user.email);
            const b = await signIn(user.email);
            const out = await request(app).post("/api/v1/auth/logout").set("Cookie", a.cookie).send({});
            assert.equal(out.status, 200);
            assert.deepEqual(out.body.data, {});
            const cleared = (out.headers["set-cookie"] || []).filter((value) => value.startsWith("refreshToken=;") || value.startsWith("accessToken=;"));
            assert.ok(cleared.length >= 2, "auth cookies are cleared");
            const aRefresh = await refresh(a.cookie);
            assert.equal(aRefresh.status, 401);
            assert.equal(codeOf(aRefresh), "REFRESH_TOKEN_INVALID");
            assert.equal((await refresh(b.cookie)).status, 200);
            const session = await AuthSession.findOne({ user: user._id, revokedReason: "logout" });
            assert.ok(session?.revokedAt);
            // Logging out with nothing at all still answers 200.
            assert.equal((await request(app).post("/api/v1/auth/logout").send({})).status, 200);
        });

        it("caps active sessions at 10 by revoking the oldest", async () => {
            const user = await createUser({ email: `many.${unique()}@demo.edu` });
            const sessions = [];
            for (let index = 0; index < 11; index += 1) sessions.push(await signIn(user.email));
            const oldest = await refresh(sessions[0].cookie);
            assert.equal(oldest.status, 401);
            assert.equal(codeOf(oldest), "REFRESH_TOKEN_INVALID");
            assert.equal((await refresh(sessions[1].cookie)).status, 200);
            assert.equal((await refresh(sessions[10].cookie)).status, 200);
            assert.equal(await AuthSession.countDocuments({ user: user._id, revokedReason: "session_limit" }), 1);
            assert.equal(await AuthSession.countDocuments({ user: user._id, revokedAt: null }), 10);
        });

        it("logout-all revokes every session and every access token", async () => {
            const user = await createUser({ email: `all.${unique()}@demo.edu` });
            const a = await signIn(user.email);
            const b = await signIn(user.email);
            const res = await request(app).post("/api/v1/auth/logout-all").set("Authorization", `Bearer ${a.token}`).send({});
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.revoked, 2);
            assert.equal((await refresh(a.cookie)).status, 401);
            assert.equal((await refresh(b.cookie)).status, 401);
            const old = await me(b.token);
            assert.equal(old.status, 401);
            assert.equal(codeOf(old), "SESSION_REVOKED");
        });
    });

    describe("password reset by email", () => {
        it("answers 503 when email is not configured", async () => {
            const res = await request(app).post("/api/v1/auth/forgot-password").send({ email: "anyone@demo.edu" });
            assert.equal(res.status, 503);
            assert.equal(codeOf(res), "EMAIL_NOT_CONFIGURED");
            const bad = await request(app).post("/api/v1/auth/forgot-password").send({ email: "nope" });
            assert.equal(codeOf(bad), "VALIDATION");
        });

        it("emails a single-use link, stores only its hash and never logs it", async () => {
            const sent = stubMailer();
            const user = await createUser({ email: `reset.${unique()}@demo.edu` });
            const a = await signIn(user.email);

            const lines = [];
            const methods = ["log", "info", "warn", "error", "debug"];
            const saved = Object.fromEntries(methods.map((name) => [name, console[name]]));
            for (const name of methods) console[name] = (...args) => lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
            process.env.AUTH_TEST_LOGS = "true";
            let res;
            try {
                res = await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email.toUpperCase() });
                await login({ email: user.email, password: "wrong-password" });
            } finally {
                Object.assign(console, saved);
                delete process.env.AUTH_TEST_LOGS;
            }
            assert.equal(res.status, 200);
            assert.equal(res.body.message, "If an account exists for that email, a reset link has been sent.");
            assert.equal(sent.length, 1);
            assert.equal(sent[0].to, user.email);
            const match = new RegExp(`${process.env.FRONTEND_URL}/reset-password/([a-f0-9]{64})`).exec(sent[0].text);
            assert.ok(match, sent[0].text);
            const token = match[1];
            const stored = await User.findById(user._id).select("+passwordResetToken");
            assert.equal(stored.passwordResetToken, sha256(token));
            assert.ok(lines.every((line) => !line.includes(token)), "the reset token is never logged");
            assert.ok(lines.some((line) => line.includes("[auth] login failed") && line.includes("r***@demo.edu")), "failed logins log a masked email");
            assert.ok(lines.every((line) => !line.includes(user.email)), "never the full email");

            const unknown = await request(app).post("/api/v1/auth/forgot-password").send({ email: `ghost.${unique()}@demo.edu` });
            assert.equal(unknown.status, 200);
            assert.equal(sent.length, 1, "no mail for an unknown email");

            // GET validates without consuming.
            const check = await request(app).get(`/api/v1/auth/reset-password/${token}`);
            assert.equal(check.status, 200);
            assert.equal(check.body.data.valid, true);
            assert.match(check.body.data.email, /^r\*\*\*@demo\.edu$/);
            assert.equal(codeOf(await request(app).get("/api/v1/auth/reset-password/abc")), "RESET_TOKEN_INVALID");
            assert.equal(codeOf(await request(app).get(`/api/v1/auth/reset-password/${"0".repeat(64)}`)), "RESET_TOKEN_INVALID");

            // A weak password does not consume the token.
            const weak = await request(app).post(`/api/v1/auth/reset-password/${token}`).send({ password: "short" });
            assert.equal(codeOf(weak), "WEAK_PASSWORD");

            const done = await request(app).post(`/api/v1/auth/reset-password/${token}`).send({ password: "Brand-New-Pass-1" });
            assert.equal(done.status, 200, JSON.stringify(done.body));
            assert.equal(done.body.message, "Password reset. Sign in with your new password.");
            assert.equal((await login({ email: user.email, password: PASSWORD })).status, 401);
            assert.equal((await login({ email: user.email, password: "Brand-New-Pass-1" })).status, 200);
            assert.equal((await refresh(a.cookie)).status, 401);
            const old = await me(a.token);
            assert.equal(old.status, 401);
            assert.equal(codeOf(old), "SESSION_REVOKED");
            const again = await request(app).post(`/api/v1/auth/reset-password/${token}`).send({ password: "Another-Pass-2" });
            assert.equal(again.status, 400);
            assert.equal(codeOf(again), "RESET_TOKEN_INVALID");
            if (mongoose.models.Notification) {
                assert.equal(await mongoose.models.Notification.countDocuments({ user: user._id, type: "security.password_changed" }), 1);
            }
            assert.ok(sent.some((message) => message.to === user.email && /password was changed/i.test(message.subject)));
        });

        it("rejects an expired reset token", async () => {
            stubMailer();
            const user = await createUser({ email: `exp.${unique()}@demo.edu` });
            const token = crypto.randomBytes(32).toString("hex");
            await User.updateOne({ _id: user._id }, { passwordResetToken: sha256(token), passwordResetExpiry: new Date(Date.now() - 1000) });
            const res = await request(app).post(`/api/v1/auth/reset-password/${token}`).send({ password: "Brand-New-Pass-1" });
            assert.equal(res.status, 400);
            assert.equal(codeOf(res), "RESET_TOKEN_INVALID");
        });

        it("lets a Google-only account set its first password through reset", async () => {
            const sent = stubMailer();
            const user = await createUser({ email: `gonly.${unique()}@demo.edu`, password: undefined, authProvider: "google", googleId: "g-2" });
            await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email }).expect(200);
            const token = /reset-password\/([a-f0-9]{64})/.exec(sent[0].text)[1];
            await request(app).post(`/api/v1/auth/reset-password/${token}`).send({ password: "First-Pass-1" }).expect(200);
            assert.equal((await login({ email: user.email, password: "First-Pass-1" })).status, 200);
        });
    });

    describe("change password", () => {
        it("keeps the current session and revokes the others", async () => {
            const user = await createUser({ email: `chg.${unique()}@demo.edu`, mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + 86_400_000) });
            const current = await signIn(user.email);
            assert.equal(current.user.mustChangePassword, true);
            const other = await signIn(user.email);

            const wrong = await request(app).post("/api/v1/auth/change-password")
                .set("Authorization", `Bearer ${current.token}`).set("Cookie", current.cookie)
                .send({ currentPassword: "not-it-1", newPassword: "Changed-Pass-1" });
            assert.equal(wrong.status, 400);
            assert.equal(codeOf(wrong), "INVALID_CURRENT_PASSWORD");
            const same = await request(app).post("/api/v1/auth/change-password")
                .set("Authorization", `Bearer ${current.token}`).send({ currentPassword: PASSWORD, newPassword: PASSWORD });
            assert.equal(codeOf(same), "VALIDATION");
            const weak = await request(app).post("/api/v1/auth/change-password")
                .set("Authorization", `Bearer ${current.token}`).send({ currentPassword: PASSWORD, newPassword: "short" });
            assert.equal(codeOf(weak), "WEAK_PASSWORD");

            const res = await request(app).post("/api/v1/auth/change-password")
                .set("Authorization", `Bearer ${current.token}`).set("Cookie", current.cookie)
                .send({ currentPassword: PASSWORD, newPassword: "Changed-Pass-1" });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.user.mustChangePassword, false);
            assert.ok(!JSON.stringify(res.body).includes("tokenVersion"));
            assert.equal((await me(res.body.data.accessToken)).status, 200, "the new access token works");
            const old = await me(current.token);
            assert.equal(old.status, 401);
            assert.equal(codeOf(old), "SESSION_REVOKED");
            assert.equal((await refresh(current.cookie)).status, 200, "the current cookie session survives");
            assert.equal((await refresh(other.cookie)).status, 401, "other sessions are revoked");
            assert.equal((await login({ email: user.email, password: "Changed-Pass-1" })).status, 200);
        });

        it("lets a Google-only account set a password without currentPassword", async () => {
            const user = await createUser({ email: `gset.${unique()}@demo.edu`, password: undefined, authProvider: "google", googleId: "g-3" });
            const res = await request(app).post("/api/v1/auth/change-password").set(authHeader(user)).send({ newPassword: "Set-By-Google-1" });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal((await login({ email: user.email, password: "Set-By-Google-1" })).status, 200);
        });
    });

    describe("secrets and token handling", () => {
        const FORBIDDEN_KEYS = ["\"password\"", "refreshToken", "passwordResetToken", "tokenVersion", "llmCredentials", "gmailRefreshTokenEncrypted"];
        const assertNoSecrets = (res) => {
            const body = JSON.stringify(res.body);
            for (const key of FORBIDDEN_KEYS) assert.ok(!body.includes(key), `${key} leaked: ${body}`);
        };

        it("never returns secrets from login, GET /me or PATCH /me", async () => {
            const user = await createUser({ email: `sec.${unique()}@demo.edu`, passwordResetToken: "x".repeat(64), passwordResetExpiry: new Date(Date.now() + 60_000) });
            const signed = await signIn(user.email);
            assertNoSecrets(signed.res);
            const got = await me(signed.token);
            assert.equal(got.status, 200);
            assert.equal(got.body.data.email, user.email);
            assertNoSecrets(got);
            const patched = await request(app).patch("/api/v1/auth/me").set("Authorization", `Bearer ${signed.token}`).send({ name: "Secret Keeper" });
            assert.equal(patched.status, 200);
            assert.equal(patched.body.data.name, "Secret Keeper");
            assertNoSecrets(patched);
        });

        it("prefers the Bearer header over the access cookie and rejects tool tokens", async () => {
            const a = await createUser({ email: `ca.${unique()}@demo.edu` });
            const b = await createUser({ email: `cb.${unique()}@demo.edu` });
            const res = await request(app).get("/api/v1/auth/me")
                .set("Cookie", `accessToken=${a.generateAccessToken()}`)
                .set("Authorization", `Bearer ${b.generateAccessToken()}`);
            assert.equal(res.status, 200);
            assert.equal(res.body.data.email, b.email);
            const cookieOnly = await request(app).get("/api/v1/auth/me").set("Cookie", `accessToken=${a.generateAccessToken()}`);
            assert.equal(cookieOnly.body.data.email, a.email);

            const toolLike = jwt.sign({ _id: String(a._id), typ: "agent-tool", tv: 0 }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "5m" });
            const rejected = await me(toolLike);
            assert.equal(rejected.status, 401);
            assert.equal(codeOf(rejected), "UNAUTHORIZED");
            assert.equal(codeOf(await request(app).get("/api/v1/auth/me")), "UNAUTHORIZED");
        });
    });

    describe("PATCH /auth/me profile rules", () => {
        const patch = (user, body) => request(app).patch("/api/v1/auth/me").set(authHeader(user)).send(body);

        it("ignores (not rejects) GGSIPU-locked cgpa and branch changes", async () => {
            const student = await createUser({ email: `lock.${unique()}@demo.edu`, ggsipuLinked: true, cgpa: 8.1, branch: "CSE" });
            const res = await patch(student, { cgpa: 9.9, branch: "IT", skills: ["Go"] });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.cgpa, 8.1);
            assert.equal(res.body.data.branch, "CSE");
            assert.deepEqual(res.body.data.skills, ["Go"]);
            assert.match(res.body.message, /GGSIPU/);
            const sameValues = await patch(student, { cgpa: 8.1, branch: "computer science" });
            assert.equal(sameValues.status, 400, "equal values are a no-op, so nothing is left to save");
            const lockedOnly = await patch(student, { cgpa: 7 });
            assert.equal(lockedOnly.status, 200);
            assert.match(lockedOnly.body.message, /GGSIPU/);
        });

        it("validates editable fields and ignores identity fields", async () => {
            const student = await createUser({ email: `edit.${unique()}@demo.edu`, cgpa: 7 });
            const ok = await patch(student, { cgpa: "8.456", branch: "information technology", passingYear: 2027 });
            assert.equal(ok.status, 200, JSON.stringify(ok.body));
            assert.equal(ok.body.data.cgpa, 8.46);
            assert.equal(ok.body.data.branch, "IT");
            assert.equal(ok.body.data.passingYear, "2027");

            const tooHigh = await patch(student, { cgpa: 11 });
            assert.equal(tooHigh.status, 400);
            assert.equal(codeOf(tooHigh), "VALIDATION");
            assert.equal(tooHigh.body.errors[0].field, "cgpa");

            const identity = await patch(student, { role: "tpo", email: "x@y.z", isActive: false });
            assert.equal(identity.status, 400);
            assert.equal(codeOf(identity), "VALIDATION");
            const stored = await User.findById(student._id);
            assert.equal(stored.role, "student");
            assert.equal(stored.email, student.email);
            assert.equal(stored.isActive, true);

            assert.equal(codeOf(await patch(student, { name: "A" })), "VALIDATION");
            assert.equal(codeOf(await patch(student, { profile: "javascript:alert(1)" })), "VALIDATION");
            assert.equal(codeOf(await patch(student, { passingYear: "1999" })), "VALIDATION");
        });

        it("applies the PLACEMENTS §3.7 academic rows for students", async () => {
            const student = await createUser({ email: `acad.${unique()}@demo.edu`, ggsipuLinked: true });
            const res = await patch(student, { activeBacklogs: "2", tenthPercentage: 91.5, twelfthPercentage: "88" });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.activeBacklogs, 2);
            assert.equal(res.body.data.tenthPercentage, 91.5);
            assert.equal(res.body.data.twelfthPercentage, 88);
            const cleared = await patch(student, { activeBacklogs: null });
            assert.equal(cleared.status, 200);
            assert.equal(cleared.body.data.activeBacklogs, undefined);
            assert.equal(codeOf(await patch(student, { activeBacklogs: 51 })), "VALIDATION");
            assert.equal(codeOf(await patch(student, { activeBacklogs: 1.5 })), "VALIDATION");
            assert.equal(codeOf(await patch(student, { tenthPercentage: 101 })), "VALIDATION");
        });

        it("canonicalises a teacher's department and ignores student-only fields", async () => {
            const teacher = await createUser({ role: "teacher", email: `dept.${unique()}@demo.edu` });
            const res = await patch(teacher, { department: "computer science", designation: "Professor", cgpa: 9 });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.department, "CSE");
            assert.equal(res.body.data.designation, "Professor");
            assert.equal(res.body.data.cgpa, undefined);
            assert.equal((await User.findById(teacher._id)).cgpa, undefined);
        });
    });

    describe("rate limits", () => {
        it("limits sign-in attempts per email and forgot-password per email", async () => {
            process.env.ENABLE_RATE_LIMIT_IN_TESTS = "true";
            const user = await createUser({ email: `limit.${unique()}@demo.edu` });
            for (let attempt = 0; attempt < 10; attempt += 1) {
                assert.equal((await login({ email: user.email, password: "wrong-pass" })).status, 401);
            }
            const blocked = await login({ email: user.email, password: PASSWORD });
            assert.equal(blocked.status, 429);
            assert.equal(codeOf(blocked), "TOO_MANY_ATTEMPTS");
            // Another email from the same IP is unaffected.
            const other = await createUser({ email: `limit2.${unique()}@demo.edu` });
            assert.equal((await login({ email: other.email, password: PASSWORD })).status, 200);

            stubMailer();
            const email = `forgot.${unique()}@demo.edu`;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                assert.equal((await request(app).post("/api/v1/auth/forgot-password").send({ email })).status, 200);
            }
            const fourth = await request(app).post("/api/v1/auth/forgot-password").send({ email });
            assert.equal(fourth.status, 429);
            assert.equal(codeOf(fourth), "TOO_MANY_ATTEMPTS");
        });
    });

    describe("sockets", () => {
        it("treats a deactivated user's token as anonymous", async () => {
            const server = await startTestServer();
            const user = await createUser({ email: `sock.${unique()}@demo.edu`, isActive: false });
            const client = ioClient(server.url, { auth: { token: user.generateAccessToken() }, transports: ["websocket"] });
            try {
                await new Promise((resolve, reject) => {
                    client.on("connect", resolve);
                    client.on("connect_error", reject);
                });
                const response = new Promise((resolve) => client.on("response", resolve));
                client.emit("query", { requestId: "r1", user_query: "hello", user_role: "student", sessionId: "s1" });
                const chunk = await response;
                assert.equal(chunk.header_message, "auth:required");
            } finally {
                client.close();
                await server.close();
            }
        });

        it("kicks a connected user who gets deactivated", async () => {
            const server = await startTestServer();
            const tpo = await createUser({ role: "tpo", email: `ktpo.${unique()}@demo.edu`, college: demoCollege._id });
            const teacher = await createUser({ role: "teacher", email: `kick.${unique()}@demo.edu`, college: demoCollege._id });
            const client = ioClient(server.url, { auth: { token: teacher.generateAccessToken() }, transports: ["websocket"], reconnection: false });
            try {
                await new Promise((resolve, reject) => {
                    client.on("connect", resolve);
                    client.on("connect_error", reject);
                });
                await sleep(50);
                const revoked = new Promise((resolve) => client.on("auth:revoked", resolve));
                const disconnected = new Promise((resolve) => client.on("disconnect", resolve));
                const res = await request(app).delete(`/api/v1/faculty/${teacher._id}`).set(authHeader(tpo));
                assert.equal(res.status, 200, JSON.stringify(res.body));
                assert.deepEqual(await revoked, { reason: "deactivated" });
                assert.equal(await disconnected, "io server disconnect");
            } finally {
                client.close();
                await server.close();
            }
        });
    });

    describe("agent context (auth-context.js, user-profile.service.js)", () => {
        it("prefers stored academic fields over client details and resolves the user's college", async () => {
            const { buildProfile, getInstitutionContext } = await import("../src/websocket/auth-context.js");
            const other = await College.create({ name: "Linked College", domain: `linked-${unique()}.edu`, branches: ["CSE"], departments: ["CSE", "IT"] });
            const user = await createUser({
                email: `ctx.${unique()}@demo.edu`, college: other._id, collegeName: "Linked College", branch: "CSE",
                cgpa: 8.2, activeBacklogs: 0, tenthPercentage: 90, passingYear: "2027", section: "A", semester: 7, rollNumber: "R1",
            });
            const profile = buildProfile(user, { cgpa: 9.9, active_backlogs: 3, tenth_percentage: 50, twelfth_percentage: 77, graduation_year: 2030, branch: "IT" });
            assert.equal(profile.cgpa, 8.2);
            assert.equal(profile.active_backlogs, 0);
            assert.equal(profile.tenth_percentage, 90);
            assert.equal(profile.twelfth_percentage, 77, "details fill gaps only");
            assert.equal(profile.graduation_year, 2027);
            assert.equal(profile.branch, "CSE");
            assert.equal(profile.college, "Linked College");
            assert.equal(profile.role, "student");
            assert.equal(profile.section, "A");
            assert.equal(profile.semester, 7);
            assert.equal(profile.roll_number, "R1");

            const institution = await getInstitutionContext(user, "student");
            assert.equal(institution.college_id, String(other._id), "user.college wins over the email domain");
            assert.equal(institution.college_name, "Linked College");
            assert.equal(institution.college_domain, other.domain);
            assert.deepEqual(institution.departments, ["CSE", "IT"]);
            assert.equal(institution.tpo_user_id, undefined);
            const tpoInstitution = await getInstitutionContext(user, "tpo");
            assert.equal(tpoInstitution.tpo_user_id, String(user._id));
        });

        it("summarises identity per role for get_my_profile", async () => {
            const { toProfileSummary } = await import("../src/services/user-profile.service.js");
            const teacher = await createUser({ role: "teacher", email: `sum.${unique()}@demo.edu`, college: demoCollege._id, department: "CSE", designation: "Professor", employeeId: "E9" });
            const summary = await toProfileSummary(teacher);
            assert.deepEqual(summary, {
                id: String(teacher._id), name: teacher.name, email: teacher.email, role: "teacher",
                college: { id: String(demoCollege._id), name: "Demo Institute of Technology", domain: "demo.edu" },
                department: "CSE", designation: "Professor", employeeId: "E9", mustChangePassword: false,
            });
            const student = await createUser({ email: `sum2.${unique()}@demo.edu`, cgpa: 7.5, skills: ["SQL"], activeBacklogs: 1 });
            const studentSummary = await toProfileSummary(student);
            assert.equal(studentSummary.cgpa, 7.5);
            assert.equal(studentSummary.activeBacklogs, 1);
            assert.equal(studentSummary.ggsipuLinked, false);
            assert.equal(studentSummary.college.domain, "demo.edu", "falls back to the email domain");
            assert.equal(studentSummary.department, undefined);
        });
    });

    describe("options and GGSIPU", () => {
        it("describes sign-in options", async () => {
            const res = await request(app).get("/api/v1/auth/options");
            assert.equal(res.status, 200);
            const { data } = res.body;
            assert.equal(data.appName, "Matchy Campus");
            assert.ok(data.collegeDomains.some((entry) => entry.domain === "demo.edu" && entry.name === "Demo Institute of Technology"));
            assert.equal(data.google.enabled, false);
            assert.equal(data.passwordReset.emailEnabled, false);
            assert.equal(data.passwordMinLength, 8);
            stubMailer();
            const withMail = await request(app).get("/api/v1/auth/options");
            assert.equal(withMail.body.data.passwordReset.emailEnabled, true);
        });

        it("keeps GGSIPU sync student-only", async () => {
            const teacher = await createUser({ role: "teacher", email: `gg.${unique()}@demo.edu` });
            const res = await request(app).get("/api/v1/ggsipu/captcha").set(authHeader(teacher));
            assert.equal(res.status, 403);
            assert.equal(codeOf(res), "FORBIDDEN");
            const connect = await request(app).post("/api/v1/ggsipu/connect").set(authHeader(teacher)).send({});
            assert.equal(codeOf(connect), "FORBIDDEN");
        });
    });
});
