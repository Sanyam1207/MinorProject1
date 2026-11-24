// Acceptance tests for docs/contracts/AUTH-FACULTY.md §4.3 / §17 auth-google.test.js:
// Google sign-in trusts ONLY a verified ID token with email_verified === true.
// The google-auth-library verifier is replaced through the googleIdentity seam.
import { connectTestDb, disconnectTestDb, createUser, getApp } from "./helpers.js";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";

process.env.TPO_EMAIL = "tpo@demo.edu";
process.env.TPO_INITIAL_PASSWORD = "Init-Pass-123";
process.env.TEACHER_EMAILS = "new.teacher@demo.edu,far.teacher@unknown.org";
process.env.CLIENT_ID = "test-client";
process.env.GOOGLE_REQUIRE_HOSTED_DOMAIN = "false";
process.env.ENABLE_RATE_LIMIT_IN_TESTS = "false";

const unique = () => crypto.randomBytes(3).toString("hex");

describe("Google sign-in (AUTH-FACULTY §4.3)", () => {
    let app;
    let User;
    let College;
    let googleIdentity;
    let authPolicySettings;
    let demoCollege;
    const originalIdentity = {};
    const originalSettings = {};

    before(async () => {
        await connectTestDb("auth_google");
        app = await getApp();
        ({ User } = await import("../src/models/user.models.js"));
        ({ College } = await import("../src/models/college.models.js"));
        ({ googleIdentity } = await import("../src/services/google-identity.service.js"));
        ({ authPolicySettings } = await import("../src/services/auth-policy.service.js"));
        Object.assign(originalIdentity, googleIdentity);
        Object.assign(originalSettings, authPolicySettings);
        demoCollege = await College.create({ name: "Demo Institute of Technology", domain: "demo.edu" });
    });
    after(disconnectTestDb);
    afterEach(() => {
        Object.assign(googleIdentity, originalIdentity);
        Object.assign(authPolicySettings, originalSettings);
    });

    const google = (body) => request(app).post("/api/v1/auth/google").send(body);
    const codeOf = (res) => res.body?.errors?.[0]?.code;
    /** Make the verifier accept any credential and return this payload. */
    const verifiedAs = (payload) => {
        const calls = [];
        googleIdentity.verifyIdToken = async (idToken) => {
            calls.push(idToken);
            return { email_verified: true, sub: `sub-${unique()}`, ...payload };
        };
        return calls;
    };

    it("is enabled because CLIENT_ID is set, and answers 503 when not configured", async () => {
        const options = await request(app).get("/api/v1/auth/options");
        assert.equal(options.body.data.google.enabled, true);
        googleIdentity.isConfigured = () => false;
        const res = await google({ credential: "anything" });
        assert.equal(res.status, 503);
        assert.equal(codeOf(res), "GOOGLE_NOT_CONFIGURED");
    });

    it("requires a credential", async () => {
        verifiedAs({ email: "x@demo.edu" });
        const res = await google({ email: "x@demo.edu" });
        assert.equal(res.status, 400);
        assert.equal(codeOf(res), "VALIDATION");
    });

    it("never falls back to client-supplied identity when verification fails", async () => {
        googleIdentity.verifyIdToken = async () => {
            throw new Error("Wrong recipient, payload audience != requiredAudience");
        };
        const res = await google({ credential: "forged", email: "victim@demo.edu", name: "Victim", googleId: "123" });
        assert.equal(res.status, 401);
        assert.equal(codeOf(res), "GOOGLE_TOKEN_INVALID");
        assert.equal(await User.countDocuments({ email: "victim@demo.edu" }), 0);

        googleIdentity.verifyIdToken = async () => ({ email_verified: true, sub: "s" });
        const noEmail = await google({ credential: "no-email" });
        assert.equal(codeOf(noEmail), "GOOGLE_TOKEN_INVALID");
    });

    it("requires email_verified === true before creating or linking", async () => {
        const email = `unverified.${unique()}@demo.edu`;
        verifiedAs({ email, email_verified: false });
        const res = await google({ credential: "c" });
        assert.equal(res.status, 403);
        assert.equal(codeOf(res), "EMAIL_NOT_VERIFIED");
        verifiedAs({ email, email_verified: "true" });
        assert.equal(codeOf(await google({ credential: "c" })), "EMAIL_NOT_VERIFIED");
        assert.equal(await User.countDocuments({ email }), 0);

        const existing = await createUser({ email: `exist.${unique()}@demo.edu` });
        verifiedAs({ email: existing.email, email_verified: false });
        assert.equal(codeOf(await google({ credential: "c" })), "EMAIL_NOT_VERIFIED");
        assert.equal((await User.findById(existing._id)).googleId, undefined, "nothing is linked");
    });

    it("registers a new verified college email as a student", async () => {
        const email = `new.${unique()}@demo.edu`;
        const calls = verifiedAs({ email: email.toUpperCase(), sub: "google-sub-1", name: "New Student", picture: "https://example.com/p.png" });
        const res = await google({ credential: "good-token", role: "student" });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.deepEqual(calls, ["good-token"]);
        const { data } = res.body;
        assert.equal(data.isNewUser, true);
        assert.ok(data.accessToken);
        assert.equal(data.refreshToken, undefined);
        assert.equal(data.user.role, "student");
        assert.equal(data.user.email, email);
        assert.equal(data.user.authProvider, "google");
        assert.equal(data.user.googleId, "google-sub-1");
        assert.equal(data.user.name, "New Student");
        assert.equal(String(data.user.college), String(demoCollege._id));
        assert.ok((res.headers["set-cookie"] || []).some((cookie) => /^refreshToken=[^;]+;.*Path=\/api\/v1\/auth/.test(cookie)));
        assert.equal((await User.findOne({ email })).password, undefined, "Google accounts have no password");
    });

    it("registers a verified TEACHER_EMAILS address as a teacher", async () => {
        verifiedAs({ email: "new.teacher@demo.edu" });
        const res = await google({ credential: "c", role: "student" });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.data.user.role, "teacher");
    });

    it("lets alumni use any domain but not students", async () => {
        verifiedAs({ email: `alum.${unique()}@gmail.com` });
        const alumni = await google({ credential: "c", role: "alumni" });
        assert.equal(alumni.status, 201, JSON.stringify(alumni.body));
        assert.equal(alumni.body.data.user.role, "alumni");

        const email = `stud.${unique()}@gmail.com`;
        verifiedAs({ email });
        const student = await google({ credential: "c", role: "student" });
        assert.equal(student.status, 400);
        assert.equal(codeOf(student), "INVALID_DOMAIN");
        assert.equal(await User.countDocuments({ email }), 0);

        verifiedAs({ email: `t.${unique()}@demo.edu` });
        assert.equal(codeOf(await google({ credential: "c", role: "faculty" })), "TEACHER_INVITE_REQUIRED");
    });

    it("links an existing local account and keeps its stored role", async () => {
        const teacher = await createUser({ role: "teacher", email: `link.${unique()}@demo.edu` });
        verifiedAs({ email: teacher.email, sub: "linked-sub", picture: "https://example.com/t.png" });
        const res = await google({ credential: "c", role: "student" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.isNewUser, false);
        assert.equal(res.body.data.user.role, "teacher");
        assert.equal(res.body.data.roleAdjusted, true);
        const stored = await User.findById(teacher._id);
        assert.equal(stored.googleId, "linked-sub");
        assert.equal(stored.profile, "https://example.com/t.png");
        assert.ok(await stored.isPasswordCorrect("Passw0rd!"), "the local password still works");
        // Same Google account again → fine.
        verifiedAs({ email: teacher.email, sub: "linked-sub" });
        assert.equal((await google({ credential: "c" })).status, 200);
    });

    it("refuses an account linked to a different Google account", async () => {
        const user = await createUser({ email: `mis.${unique()}@demo.edu`, googleId: "original-sub" });
        verifiedAs({ email: user.email, sub: "other-sub" });
        const res = await google({ credential: "c" });
        assert.equal(res.status, 403);
        assert.equal(codeOf(res), "GOOGLE_ACCOUNT_MISMATCH");
    });

    it("refuses a deactivated account", async () => {
        const user = await createUser({ email: `dis.${unique()}@demo.edu`, isActive: false });
        verifiedAs({ email: user.email });
        const res = await google({ credential: "c" });
        assert.equal(res.status, 403);
        assert.equal(codeOf(res), "ACCOUNT_DISABLED");
    });

    it("ignores the temporary-password expiry (only isActive applies)", async () => {
        const teacher = await createUser({
            role: "teacher",
            email: `tmp.${unique()}@demo.edu`,
            mustChangePassword: true,
            tempPasswordExpiresAt: new Date(Date.now() - 1000),
        });
        verifiedAs({ email: teacher.email });
        assert.equal((await google({ credential: "c" })).status, 200);
    });

    it("enforces the hosted domain when GOOGLE_REQUIRE_HOSTED_DOMAIN is on", async () => {
        authPolicySettings.requireHostedDomain = true;
        const email = `hd.${unique()}@demo.edu`;
        verifiedAs({ email });
        const res = await google({ credential: "c" });
        assert.equal(res.status, 403);
        assert.equal(codeOf(res), "HOSTED_DOMAIN_REQUIRED");
        assert.equal(await User.countDocuments({ email }), 0);
        verifiedAs({ email, hd: "demo.edu" });
        assert.equal((await google({ credential: "c" })).status, 201);
    });

    it("bootstraps the TPO from a verified TPO_EMAIL", async () => {
        verifiedAs({ email: "tpo@demo.edu" });
        const res = await google({ credential: "c", role: "student" });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.data.user.role, "tpo");
        assert.equal(String((await College.findById(demoCollege._id)).tpo), String(res.body.data.user._id));
    });
});
