// Job feed REST API: auth, list/search filters, categories, sources, single jobs,
// the student tracker and the sync endpoints (docs/contracts/JOB-FEED.md §16.1, tests 15–20).
// No network: the global fetch throws and the sync service runs fake sources.
import { connectTestDb, disconnectTestDb, createUser, authHeader, getApp } from "./helpers.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import request from "supertest";
import { ExternalJob } from "../src/modules/job-feed/models/external-job.model.js";
import { JobSyncRun } from "../src/modules/job-feed/models/job-sync-run.model.js";
import { SavedJob } from "../src/modules/job-feed/models/saved-job.model.js";
import { jobSyncService } from "../src/modules/job-feed/sync.service.js";

const BASE = "/api/v1/job-feed";
const realFetch = globalThis.fetch;
const HOUR = 60 * 60 * 1000;
const PUBLIC_KEYS = [
    "applyUrl", "categories", "company", "companyLogo", "createdAt", "description", "experience", "id", "isNew",
    "isSample", "jobType", "kind", "lastSeenAt", "location", "postedAt", "salary", "saved", "sources", "title", "workType",
].sort();

let app;
let student;
let otherStudent;
let teacher;
let tpo;
let admin;

const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

const fakeSource = (name, jobs) => ({
    name,
    async *fetchBatches() {
        yield jobs;
    },
});

const slowSource = (name, jobs, gate) => ({
    name,
    async *fetchBatches() {
        await gate;
        yield jobs;
    },
});

async function seedJobs() {
    await jobSyncService.ingest("debugwithshubham", [
        { externalId: "a", title: "Backend Engineer", company: "Acme", location: "Pune", applyUrl: "https://acme.com/jobs/11111", jobType: "FullTime", workType: "Onsite", postedAt: ago(30) },
        { externalId: "b", title: "SDE Intern", company: "Acme", location: "Bengaluru, Karnataka", applyUrl: "https://acme.com/jobs/22222", jobType: "Internship", workType: "Hybrid", postedAt: ago(2) },
        { externalId: "c", title: "Frontend Engineer", company: "Acme", location: "Remote", applyUrl: "https://acme.com/jobs/33333", jobType: "FullTime", workType: "Remote", postedAt: ago(10) },
    ]);
    await jobSyncService.ingest("artha", [
        { externalId: "d", title: "React Developer", company: "Beta", location: "Mumbai", applyUrl: "https://beta.io/careers/44444", jobType: "full-time", categories: ["developer", "engineer"], description: "Build dashboards with React and TypeScript. C++ is a plus.", postedAt: ago(50) },
        { externalId: "e", title: "Corporate Counsel", company: "Gamma", location: "Delhi", applyUrl: "https://gamma.in/jobs/55555", jobType: "full-time", categories: ["legal"], postedAt: ago(60) },
    ]);
    await jobSyncService.ingest("whatsapp", [
        { externalId: "msg-1", title: "Data Analyst", company: "Delta", location: "Gurgaon", postedAt: ago(200) },
    ]);
}

before(async () => {
    globalThis.fetch = async () => {
        throw new Error("network disabled in tests");
    };
    await connectTestDb("job_feed_api");
    app = await getApp();
});

after(async () => {
    globalThis.fetch = realFetch;
    jobSyncService.sources = null;
    delete process.env.ADMIN_SYNC_SECRET;
    await disconnectTestDb();
});

beforeEach(async () => {
    const { User } = await import("../src/models/user.models.js");
    await Promise.all([ExternalJob.deleteMany({}), SavedJob.deleteMany({}), JobSyncRun.deleteMany({}), User.deleteMany({})]);
    student = await createUser({ role: "student", skills: ["React", "TypeScript"] });
    otherStudent = await createUser({ role: "student" });
    teacher = await createUser({ role: "teacher" });
    tpo = await createUser({ role: "tpo" });
    admin = await createUser({ role: "admin" });
    jobSyncService.sources = [];
    await seedJobs();
});

const get = (path, user) => {
    const req = request(app).get(`${BASE}${path}`);
    return user ? req.set(authHeader(user)) : req;
};
const titles = (res) => res.body.data.jobs.map((job) => job.title);
const jobId = async (title) => String((await ExternalJob.findOne({ title }).lean())._id);

describe("auth", () => {
    it("rejects requests without a token", async () => {
        const id = await jobId("SDE Intern");
        for (const path of ["", "/categories", "/sources", "/saved", `/${id}`, "/sync/status"]) {
            assert.equal((await get(path)).status, 401, path);
        }
        assert.equal((await request(app).post(`${BASE}/sync`)).status, 401);
        assert.equal((await request(app).put(`${BASE}/saved/${id}`).send({})).status, 401);
    });
});

describe("GET / (list and search)", () => {
    it("lists newest first with paging and the public shape", async () => {
        const first = await get("?limit=2", student);
        assert.equal(first.status, 200);
        assert.equal(first.body.success, true);
        assert.deepEqual(titles(first), ["SDE Intern", "Frontend Engineer"]);
        assert.deepEqual([first.body.data.page, first.body.data.limit, first.body.data.total, first.body.data.hasNextPage], [1, 2, 6, true]);
        assert.deepEqual(Object.keys(first.body.data.jobs[0]).sort(), PUBLIC_KEYS);
        assert.deepEqual(first.body.data.filters, { q: null, jobType: null, workType: null, category: null, source: null, location: null, sort: "newest" });
        const [intern] = first.body.data.jobs;
        assert.deepEqual([intern.kind, intern.isNew, intern.isSample, intern.saved, intern.jobType], ["external", true, false, null, "internship"]);

        const last = await get("?page=3&limit=2", student);
        assert.deepEqual(titles(last), ["Corporate Counsel", "Data Analyst"]);
        assert.equal(last.body.data.hasNextPage, false);
        assert.equal((await get("?page=0", student)).body.data.page, 1);
        assert.equal((await get("?limit=500", student)).body.data.limit, 50);
    });

    it("filters by job type, work type, category, source and location", async () => {
        assert.deepEqual(titles(await get("?jobType=FullTime", student)), ["Frontend Engineer", "Backend Engineer", "React Developer", "Corporate Counsel"]);
        assert.deepEqual(titles(await get("?jobType=intern", student)), ["SDE Intern"]);
        const banana = await get("?jobType=banana", student);
        assert.equal(banana.status, 400);
        assert.equal(banana.body.errors[0].code, "VALIDATION");
        assert.equal(banana.body.errors[0].field, "jobType");
        assert.equal(banana.body.message, "Unknown job type. Use one of: full-time, part-time, internship, contract.");

        assert.deepEqual(titles(await get("?workType=wfh", student)), ["Frontend Engineer"]);
        const badWork = await get("?workType=moon", student);
        assert.deepEqual([badWork.status, badWork.body.errors[0].field], [400, "workType"]);

        assert.deepEqual(titles(await get("?category=Developer", student)), ["React Developer"]);
        assert.equal((await get("?category=nursing", student)).body.data.total, 0);
        assert.deepEqual(titles(await get("?source=whatsapp", student)), ["Data Analyst"]);
        assert.deepEqual(titles(await get("?source=WhatsApp", student)), ["Data Analyst"]);
        assert.equal((await get("?source=nowhere", student)).body.data.total, 0);
        assert.deepEqual(titles(await get("?location=Bangalore", student)), ["SDE Intern"]);
        assert.deepEqual(titles(await get("?location=gurugram", student)), ["Data Analyst"]);
    });

    it("q is an AND of tokens over title, company, location, categories and description", async () => {
        assert.deepEqual(titles(await get("?q=engineer%20acme", student)), ["Frontend Engineer", "Backend Engineer"]);
        assert.deepEqual(titles(await get("?q=engineer%20pune", student)), ["Backend Engineer"]);
        assert.deepEqual(titles(await get("?q=dashboards%20typescript", student)), ["React Developer"]);
        assert.deepEqual(titles(await get("?q=legal", student)), ["Corporate Counsel"]);
        assert.deepEqual(titles(await get("?query=legal", student)), ["Corporate Counsel"]);
        const cpp = await get(`?q=${encodeURIComponent("c++")}`, student);
        assert.equal(cpp.status, 200);
        assert.deepEqual(titles(cpp), ["React Developer"]);
        for (const q of [".net", "(", "a[", "*"]) {
            assert.equal((await get(`?q=${encodeURIComponent(q)}`, student)).status, 200, q);
        }
        assert.equal((await get("?q=x", student)).body.data.total, 6); // 1-char tokens are dropped
    });

    it("sort=match ranks by profile fit and returns matchScore; unknown sorts are rejected", async () => {
        const res = await get("?sort=match", student);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.jobs[0].title, "React Developer");
        assert.equal(typeof res.body.data.jobs[0].matchScore, "number");
        assert.deepEqual(res.body.data.jobs[0].matchedSkills, ["React", "TypeScript"]);
        assert.ok(res.body.data.jobs.every((job) => "matchScore" in job));
        assert.equal(res.body.data.filters.sort, "match");
        assert.equal(res.body.data.hasNextPage, false);

        const newest = await get("", student);
        assert.ok(newest.body.data.jobs.every((job) => !("matchScore" in job)));

        const bad = await get("?sort=foo", student);
        assert.deepEqual([bad.status, bad.body.errors[0].code, bad.body.errors[0].field], [400, "VALIDATION", "sort"]);
    });
});

describe("categories and sources", () => {
    it("GET /categories counts categories, most common first", async () => {
        await jobSyncService.ingest("debugwithshubham", [{ externalId: "f", title: "Corporate Counsel", applyUrl: "https://gamma.in/jobs/55555", categories: ["compliance"] }]);
        const res = await get("/categories", student);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.categories, [
            { value: "compliance", count: 1 },
            { value: "developer", count: 1 },
            { value: "engineer", count: 1 },
            { value: "legal", count: 1 },
        ]);
    });

    it("GET /sources lists the four sources with counts and flags", async () => {
        const res = await get("/sources", teacher);
        assert.equal(res.status, 200);
        const sources = res.body.data.sources;
        assert.deepEqual(sources.map((source) => source.name), ["debugwithshubham", "artha", "whatsapp", "sample"]);
        const byName = Object.fromEntries(sources.map((source) => [source.name, source]));
        assert.deepEqual(
            sources.map((source) => [source.name, source.label, source.kind, source.count]),
            [["debugwithshubham", "DebugWithShubham", "poll", 3], ["artha", "artha.link", "poll", 2], ["whatsapp", "WhatsApp", "push", 1], ["sample", "Sample", "seed", 0]],
        );
        assert.equal(byName.debugwithshubham.enabled, true);
        assert.equal(byName.artha.enabled, false);
        assert.equal(byName.whatsapp.enabled, false);
        assert.equal(byName.sample.enabled, false);
        assert.deepEqual(Object.keys(byName.artha).sort(), ["count", "enabled", "kind", "label", "lastError", "lastSyncedAt", "name"]);
    });
});

describe("GET /:id", () => {
    it("returns the job with the owner's saved state, 400 for a bad id and 404 for an unknown one", async () => {
        const id = await jobId("React Developer");
        await request(app).put(`${BASE}/saved/${id}`).set(authHeader(student)).send({ notes: "Looks great" }).expect(201);

        const mine = await get(`/${id}`, student);
        assert.equal(mine.status, 200);
        assert.equal(mine.body.data.job.id, id);
        assert.equal(mine.body.data.job.saved.status, "saved");
        assert.equal(mine.body.data.job.saved.notes, "Looks great");
        assert.equal(typeof mine.body.data.job.matchScore, "number");

        assert.equal((await get(`/${id}`, otherStudent)).body.data.job.saved, null);
        assert.equal((await get(`/${id}`, tpo)).body.data.job.saved, null);

        const bad = await get("/not-an-id", student);
        assert.deepEqual([bad.status, bad.body.errors[0].code], [400, "VALIDATION"]);
        const missing = await get(`/${new mongoose.Types.ObjectId()}`, student);
        assert.deepEqual([missing.status, missing.body.errors[0].code, missing.body.message], [404, "NOT_FOUND", "This job is no longer in the feed."]);
    });
});

describe("tracker", () => {
    it("saves, updates, lists and removes tracker entries per student", async () => {
        const id = await jobId("SDE Intern");
        const put = (user, body, jobIdValue = id) => request(app).put(`${BASE}/saved/${jobIdValue}`).set(authHeader(user)).send(body);

        const created = await put(student, {});
        assert.equal(created.status, 201);
        const item = created.body.data.item;
        assert.equal(item.status, "saved");
        assert.equal(item.jobId, id);
        assert.equal(item.history.length, 1);
        assert.equal(item.appliedAt, null);
        assert.equal(item.jobAvailable, true);
        assert.equal(item.job.id, id);
        assert.equal("saved" in item.job, false);
        assert.deepEqual(
            [item.snapshot.title, item.snapshot.company, item.snapshot.jobType, item.snapshot.sources],
            ["SDE Intern", "Acme", "internship", ["debugwithshubham"]],
        );

        const applied = await put(student, { status: "applied" });
        assert.equal(applied.status, 200);
        assert.equal(applied.body.data.item.status, "applied");
        assert.ok(applied.body.data.item.appliedAt);
        assert.equal(applied.body.data.item.history.length, 2);

        const back = await put(student, { status: "saved", notes: "Apply next week" });
        assert.equal(back.body.data.item.appliedAt, null);
        assert.equal(back.body.data.item.notes, "Apply next week");

        const second = await jobId("React Developer");
        await put(student, { status: "interviewing" }, second).expect(201);

        const list = await get("/saved", student);
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.data.items.map((entry) => entry.jobId), [second, id]);
        assert.deepEqual(list.body.data.counts, { saved: 1, applied: 0, interviewing: 1, offer: 0, rejected: 0, total: 2 });
        assert.deepEqual([list.body.data.page, list.body.data.limit, list.body.data.total, list.body.data.hasNextPage], [1, 50, 2, false]);
        assert.deepEqual((await get("/saved?status=interviewing", student)).body.data.items.map((entry) => entry.jobId), [second]);
        assert.equal((await get("/saved?status=maybe", student)).status, 400);

        const others = await get("/saved", otherStudent);
        assert.deepEqual([others.body.data.items.length, others.body.data.counts.total], [0, 0]);

        const removed = await request(app).delete(`${BASE}/saved/${id}`).set(authHeader(student));
        assert.deepEqual([removed.status, removed.body.data], [200, { deleted: true }]);
        const again = await request(app).delete(`${BASE}/saved/${id}`).set(authHeader(student));
        assert.deepEqual([again.status, again.body.errors[0].code], [404, "NOT_FOUND"]);
    });

    it("validates input and roles", async () => {
        const id = await jobId("SDE Intern");
        const put = (user, body, path = id) => request(app).put(`${BASE}/saved/${path}`).set(authHeader(user)).send(body);

        const unknown = await put(student, {}, String(new mongoose.Types.ObjectId()));
        assert.deepEqual([unknown.status, unknown.body.errors[0].code, unknown.body.message], [404, "NOT_FOUND", "This job is no longer in the feed."]);
        const badId = await put(student, {}, "nope");
        assert.deepEqual([badId.status, badId.body.errors[0].code], [400, "VALIDATION"]);
        const badStatus = await put(student, { status: "hired" });
        assert.deepEqual([badStatus.status, badStatus.body.errors[0].field], [400, "status"]);
        const longNotes = await put(student, { notes: "x".repeat(2001) });
        assert.deepEqual([longNotes.status, longNotes.body.errors[0].field], [400, "notes"]);
        const numberNotes = await put(student, { notes: 42 });
        assert.deepEqual([numberNotes.status, numberNotes.body.errors[0].field], [400, "notes"]);

        const forbidden = await put(teacher, {});
        assert.deepEqual([forbidden.status, forbidden.body.errors[0].code], [403, "FORBIDDEN"]);
        assert.equal((await get("/saved", teacher)).status, 403);
        assert.equal((await get("/saved", tpo)).status, 403);
        assert.equal((await put(admin, {})).status, 201); // admin passes every role check
    });

    it("keeps an entry with its snapshot after the job is purged", async () => {
        const id = await jobId("Backend Engineer");
        await request(app).put(`${BASE}/saved/${id}`).set(authHeader(student)).send({ status: "applied" }).expect(201);
        await ExternalJob.deleteOne({ _id: id });

        const list = await get("/saved", student);
        const [entry] = list.body.data.items;
        assert.deepEqual([entry.jobAvailable, entry.job, entry.snapshot.title, entry.snapshot.applyUrl], [false, null, "Backend Engineer", "https://acme.com/jobs/11111"]);
        const updated = await request(app).put(`${BASE}/saved/${id}`).set(authHeader(student)).send({ status: "rejected" });
        assert.deepEqual([updated.status, updated.body.data.item.status], [200, "rejected"]);
    });
});

describe("sync", () => {
    const fresh = [{ externalId: "s1", title: "Platform Engineer", company: "Omega", applyUrl: "https://omega.dev/jobs/90001" }];

    it("allows TPO and admin only, answers 202 at once and persists the run", async () => {
        jobSyncService.sources = [fakeSource("debugwithshubham", fresh)];
        assert.equal((await request(app).post(`${BASE}/sync`).set(authHeader(student))).status, 403);
        assert.equal((await request(app).post(`${BASE}/sync`).set(authHeader(teacher))).status, 403);

        const res = await request(app).post(`${BASE}/sync`).set(authHeader(tpo));
        assert.equal(res.status, 202);
        assert.equal(res.body.data.run.status, "running");
        assert.equal(res.body.data.run.trigger, "manual");
        assert.equal(res.body.data.run.triggeredBy.id, String(tpo._id));
        assert.equal(res.body.data.alreadyRunning, false);
        const finished = await jobSyncService.sync();
        assert.equal(finished.id, res.body.data.run.id);
        const stored = await JobSyncRun.findById(res.body.data.run.id).lean();
        assert.equal(stored.status, "ok");
        assert.equal(String(stored.triggeredBy), String(tpo._id));

        const byAdmin = await request(app).post(`${BASE}/sync`).set(authHeader(admin));
        assert.equal(byAdmin.status, 202);
        await jobSyncService.sync();
    });

    it("?wait=true answers with the finished run; a running sync is shared", async () => {
        jobSyncService.sources = [fakeSource("debugwithshubham", fresh)];
        const waited = await request(app).post(`${BASE}/sync?wait=true`).set(authHeader(tpo));
        assert.equal(waited.status, 200);
        assert.equal(waited.body.data.run.status, "ok");
        assert.equal(waited.body.data.run.totals.inserted, 1);
        assert.equal(waited.body.data.run.results[0].label, "DebugWithShubham");

        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        jobSyncService.sources = [slowSource("debugwithshubham", fresh, gate)];
        const first = await request(app).post(`${BASE}/sync`).set(authHeader(tpo));
        const second = await request(app).post(`${BASE}/sync`).set(authHeader(admin));
        assert.deepEqual([first.body.data.alreadyRunning, second.body.data.alreadyRunning], [false, true]);
        assert.equal(second.body.data.run.id, first.body.data.run.id);

        const status = await get("/sync/status", tpo);
        assert.equal(status.body.data.running, true);
        assert.equal(status.body.data.current.id, first.body.data.run.id);
        release();
        await jobSyncService.sync();
    });

    it("accepts the cron secret header and rejects a wrong or unset secret", async () => {
        jobSyncService.sources = [fakeSource("debugwithshubham", fresh)];
        delete process.env.ADMIN_SYNC_SECRET;
        const unset = await request(app).post(`${BASE}/sync`).set("x-admin-sync-secret", "anything");
        assert.deepEqual([unset.status, unset.body.errors[0].code], [401, "INVALID_SYNC_SECRET"]);

        process.env.ADMIN_SYNC_SECRET = "cron-secret-for-tests";
        try {
            const wrong = await request(app).post(`${BASE}/sync`).set("x-admin-sync-secret", "cron-secret-for-test");
            assert.deepEqual([wrong.status, wrong.body.errors[0].code, wrong.body.message], [401, "INVALID_SYNC_SECRET", "Invalid sync secret"]);
            const ok = await request(app).post(`${BASE}/sync`).set("x-admin-sync-secret", "cron-secret-for-tests");
            assert.equal(ok.status, 202);
            assert.equal(ok.body.data.run.trigger, "cron");
            assert.equal(ok.body.data.run.triggeredBy, null);
            await jobSyncService.sync();
        } finally {
            delete process.env.ADMIN_SYNC_SECRET;
        }
    });

    it("GET /sync/status reports runs, schedule, sources, WhatsApp and totals to TPO/admin only", async () => {
        jobSyncService.sources = [fakeSource("debugwithshubham", fresh)];
        await request(app).post(`${BASE}/sync?wait=true`).set(authHeader(tpo)).expect(200);
        jobSyncService.sources = [{ name: "artha", async *fetchBatches() { throw new Error("The artha.link jobs API returned HTTP 503."); } }];
        await request(app).post(`${BASE}/sync?wait=true`).set(authHeader(admin)).expect(200);

        assert.equal((await get("/sync/status", student)).status, 403);
        assert.equal((await get("/sync/status", teacher)).status, 403);
        const res = await get("/sync/status", tpo);
        assert.equal(res.status, 200);
        const data = res.body.data;
        assert.deepEqual(Object.keys(data).sort(), ["current", "lastRun", "lastSuccessfulRun", "recentRuns", "running", "schedule", "sources", "totals", "whatsapp"]);
        assert.equal(data.running, false);
        assert.equal(data.current, null);
        assert.equal(data.lastRun.status, "failed");
        assert.equal(data.lastRun.triggeredBy.name, admin.name);
        assert.equal(data.lastSuccessfulRun.status, "ok");
        assert.equal(data.recentRuns.length, 2);
        assert.deepEqual(Object.keys(data.lastRun).sort(), [
            "durationMs", "error", "finishedAt", "id", "results", "sampleJobsRemoved", "startedAt", "status", "totals", "trigger", "triggeredBy",
        ]);
        assert.deepEqual(data.schedule, { intervalMinutes: 0, onBoot: true, enabled: false, nextRunAt: null });
        assert.equal(data.sources.length, 4);
        const artha = data.sources.find((source) => source.name === "artha");
        assert.equal(artha.lastError, "The artha.link jobs API returned HTTP 503.");
        const dws = data.sources.find((source) => source.name === "debugwithshubham");
        assert.ok(dws.lastSyncedAt);
        assert.equal(dws.lastError, null);
        assert.deepEqual(data.whatsapp, {
            enabled: false, state: "disabled", reason: null, channels: 0, extractor: null, lastPostAt: null, posts: { saved: 0, ignored: 0, failed: 0 },
        });
        assert.deepEqual(data.totals, { jobs: 7, sampleJobs: 0, savedJobs: 0, newLast24h: 3 });
        assert.equal((await get("/sync/status", admin)).status, 200);
    });
});
