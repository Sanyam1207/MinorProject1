// Job feed copilot tools (docs/contracts/JOB-FEED.md §10, §16.1 tests 21–25):
// definitions, handlers and the /api/v1/agent-tools/execute round trip.
import { connectTestDb, disconnectTestDb, createUser, agentToolToken, getApp } from "./helpers.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import request from "supertest";
import { ApiError } from "../src/utils/api-error.js";
import { ExternalJob } from "../src/modules/job-feed/models/external-job.model.js";
import { JobSyncRun } from "../src/modules/job-feed/models/job-sync-run.model.js";
import { SavedJob } from "../src/modules/job-feed/models/saved-job.model.js";
import { jobSyncService } from "../src/modules/job-feed/sync.service.js";
import tools from "../src/modules/job-feed/tools.js";
import jobFeedModule from "../src/modules/job-feed/index.js";
import { upsertSavedJob } from "../src/modules/job-feed/tracker.service.js";

const realFetch = globalThis.fetch;
const HOUR = 60 * 60 * 1000;
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

let app;
let student;
let teacher;
let tpo;

const ctxFor = (user) => ({ user, role: user.role, requestId: "r-1", sessionId: "s-1", now: new Date(), timezone: "Asia/Kolkata" });
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const idOf = async (title, company) => String((await ExternalJob.findOne(company ? { title, company } : { title }).lean())._id);

const fakeSource = (name, jobs) => ({
    name,
    async *fetchBatches() {
        yield jobs;
    },
});

before(async () => {
    globalThis.fetch = async () => {
        throw new Error("network disabled in tests");
    };
    await connectTestDb("job_feed_tools");
    app = await getApp();
});

after(async () => {
    globalThis.fetch = realFetch;
    jobSyncService.sources = null;
    await disconnectTestDb();
});

beforeEach(async () => {
    const { User } = await import("../src/models/user.models.js");
    await Promise.all([ExternalJob.deleteMany({}), SavedJob.deleteMany({}), JobSyncRun.deleteMany({}), User.deleteMany({})]);
    student = await createUser({ role: "student", skills: ["SQL", "Excel"], careerPreferences: { preferredRoles: ["Data Analyst"], preferredLocations: ["Gurgaon"] } });
    teacher = await createUser({ role: "teacher" });
    tpo = await createUser({ role: "tpo" });
    jobSyncService.sources = [];
    await jobSyncService.ingest("debugwithshubham", [
        { externalId: "a", title: "Data Analyst Intern", company: "Northwind Analytics", location: "Gurugram", jobType: "internship", workType: "hybrid", applyUrl: "https://northwind.example/jobs/10001", description: "SQL and Excel every day.", postedAt: ago(5) },
        { externalId: "b", title: "Data Analyst", company: "Contoso", location: "Pune", jobType: "full-time", applyUrl: "https://contoso.example/jobs/10002", postedAt: ago(1) },
        { externalId: "c", title: "Data Analyst", company: "Fabrikam", location: "Chennai", jobType: "full-time", applyUrl: "https://fabrikam.example/jobs/10003", postedAt: ago(2) },
        { externalId: "d", title: "Backend Developer", company: "Wingtip", location: "Remote", workType: "remote", applyUrl: "https://wingtip.example/jobs/10004", postedAt: ago(3) },
    ]);
});

describe("definitions", () => {
    it("exports exactly the four job-feed tools with the contract's roles and confirm flags", () => {
        assert.deepEqual(jobFeedModule.tools, tools);
        assert.deepEqual(jobFeedModule.mountPath, "/api/v1/job-feed");
        assert.deepEqual(tools.map((tool) => tool.name), ["jobs_search_market", "market_job_save", "market_job_mark_applied", "job_feed_sync"]);
        assert.deepEqual(byName.jobs_search_market.roles, ["student", "teacher", "tpo", "company", "admin", "alumni"]);
        assert.deepEqual(byName.market_job_save.roles, ["student"]);
        assert.deepEqual(byName.market_job_mark_applied.roles, ["student"]);
        assert.deepEqual(byName.job_feed_sync.roles, ["tpo", "admin"]);
        assert.deepEqual(tools.map((tool) => tool.confirm), [false, false, false, true]);
        for (const tool of tools) {
            assert.equal(tool.parameters.type, "object");
            assert.equal(typeof tool.parameters.properties, "object");
            assert.equal(typeof tool.description, "string");
            assert.equal(typeof tool.handler, "function");
        }
        assert.deepEqual(Object.keys(byName.jobs_search_market.parameters.properties), ["query", "category", "jobType", "workType", "location", "source", "sort", "limit"]);
        assert.deepEqual(byName.jobs_search_market.parameters.properties.source.enum, ["debugwithshubham", "artha", "whatsapp", "sample"]);
        assert.deepEqual(byName.market_job_save.parameters.required, ["job"]);
        assert.deepEqual(byName.market_job_mark_applied.parameters.required, ["job"]);
        assert.equal(typeof byName.job_feed_sync.preview, "function");
        assert.match(byName.jobs_search_market.description, /NOT the college's campus drives/);
    });
});

describe("jobs_search_market", () => {
    it("ranks by profile fit for students and opens the market panel with highlights", async () => {
        const result = await byName.jobs_search_market.handler({ query: "data analyst" }, ctxFor(student));
        assert.equal(result.data.total, 3);
        assert.equal(result.data.jobs[0].title, "Data Analyst Intern");
        assert.equal(typeof result.data.jobs[0].matchScore, "number");
        assert.deepEqual(result.data.jobs[0].matchedSkills, ["SQL", "Excel"]);
        assert.equal(result.data.filters.sort, "match");
        assert.deepEqual(result.ui, {
            panel: "jobs.market",
            params: { query: "data analyst", sort: "match", highlightIds: result.data.jobs.map((job) => job.id) },
        });
        assert.match(result.summary, /^Found 3 open-market jobs for “data analyst”\. Top matches: 1\) Data Analyst Intern — Northwind Analytics \(Gurugram\) · \d+% fit; 2\) /);
    });

    it("sorts newest first for staff, clamps the limit and reports zero results", async () => {
        const staff = await byName.jobs_search_market.handler({ limit: 99 }, ctxFor(tpo));
        assert.equal(staff.data.filters.sort, "newest");
        assert.equal(staff.data.jobs[0].title, "Data Analyst");
        assert.equal(staff.data.jobs[0].company, "Contoso");
        assert.equal("matchScore" in staff.data.jobs[0], false);
        assert.equal(staff.ui.panel, "tpo.job-feed");
        assert.deepEqual(staff.ui.params, { sort: "newest" });

        const teacherResult = await byName.jobs_search_market.handler({ query: "developer", workType: "remote" }, ctxFor(teacher));
        assert.equal(teacherResult.data.total, 1);
        assert.equal(teacherResult.ui, undefined);

        const none = await byName.jobs_search_market.handler({ query: "astronaut", location: "Pune", jobType: "internship" }, ctxFor(student));
        assert.equal(none.data.total, 0);
        assert.equal(none.summary, "No open-market jobs match for “astronaut” · internship · Pune. Try fewer keywords or another location.");
    });
});

describe("market_job_save / market_job_mark_applied", () => {
    it("saves by id or by 'Title at Company', asks on ambiguity and 404s on unknown jobs", async () => {
        const northwind = await idOf("Data Analyst Intern");
        const byId = await byName.market_job_save.handler({ job: northwind }, ctxFor(student));
        assert.equal(byId.summary, "Saved “Data Analyst Intern” at Northwind Analytics to your job tracker.");
        assert.equal(byId.data.created, true);
        assert.equal(byId.data.item.status, "saved");
        assert.deepEqual(byId.ui, { panel: "jobs.tracker", params: { highlightId: northwind } });

        const again = await byName.market_job_save.handler({ job: northwind, notes: "Ask Priya for a referral" }, ctxFor(student));
        assert.equal(again.summary, "“Data Analyst Intern” at Northwind Analytics is already in your tracker (saved).");
        assert.equal(again.data.created, false);
        assert.equal(again.data.item.notes, "Ask Priya for a referral");

        const byText = await byName.market_job_save.handler({ job: "Data Analyst at Fabrikam" }, ctxFor(student));
        assert.equal(byText.data.item.jobId, await idOf("Data Analyst", "Fabrikam"));

        const ambiguous = await byName.market_job_save.handler({ job: "data analyst" }, ctxFor({ ...student.toObject(), _id: new mongoose.Types.ObjectId(), role: "student" }));
        assert.equal(ambiguous.ambiguous, true);
        assert.equal(ambiguous.message, "Several jobs match 'data analyst'. Which one?");
        assert.ok(ambiguous.candidates.length >= 2 && ambiguous.candidates.length <= 5);
        assert.equal(ambiguous.candidates[0].label, "Data Analyst — Contoso (Pune)");

        await assert.rejects(
            byName.market_job_save.handler({ job: "Astronaut at Nowhere" }, ctxFor(student)),
            (error) => error instanceof ApiError && error.statusCode === 404 && error.errors[0].code === "NOT_FOUND"
                && error.message === "No open-market job matches 'Astronaut at Nowhere'.",
        );
        await assert.rejects(
            byName.market_job_save.handler({ job: String(new mongoose.Types.ObjectId()) }, ctxFor(student)),
            (error) => error instanceof ApiError && error.statusCode === 404 && /Campus drives are applied to with drive_apply/.test(error.message),
        );
    });

    it("resolves text against the student's tracker first", async () => {
        const contoso = await idOf("Data Analyst", "Contoso");
        await upsertSavedJob({ user: student, jobId: contoso });
        const result = await byName.market_job_mark_applied.handler({ job: "data analyst" }, ctxFor(student));
        assert.equal(result.data.item.jobId, contoso);
    });

    it("marks jobs as applied, keeping later stages unchanged", async () => {
        const northwind = await idOf("Data Analyst Intern");
        const applied = await byName.market_job_mark_applied.handler({ job: "Data Analyst Intern at Northwind Analytics" }, ctxFor(student));
        assert.match(applied.summary, /^Marked “Data Analyst Intern” at Northwind Analytics as applied on \d{1,2} [A-Z][a-z]{2}\. Good luck!$/);
        assert.equal(applied.data.item.status, "applied");
        assert.ok(applied.data.item.appliedAt);
        assert.equal(applied.data.created, true);
        assert.equal(applied.data.previousStatus, null);
        assert.deepEqual(applied.ui, { panel: "jobs.tracker", params: { status: "applied", highlightId: northwind } });

        await upsertSavedJob({ user: student, jobId: northwind, status: "interviewing" });
        const kept = await byName.market_job_mark_applied.handler({ job: northwind }, ctxFor(student));
        assert.equal(kept.summary, "“Data Analyst Intern” at Northwind Analytics is already marked as interviewing.");
        assert.equal(kept.data.item.status, "interviewing");
        assert.equal(kept.data.previousStatus, "interviewing");
    });
});

describe("job_feed_sync", () => {
    it("previews without side effects and runs a sync with a summary", async () => {
        jobSyncService.sources = [
            fakeSource("debugwithshubham", [
                { externalId: "n1", title: "Cloud Engineer", company: "Litware", applyUrl: "https://litware.example/jobs/20001" },
                { externalId: "n2", title: "Data Analyst", company: "Contoso", applyUrl: "https://contoso.example/jobs/10002" },
                { externalId: "n3" },
            ]),
            { name: "artha", async *fetchBatches() { throw new Error("The artha.link jobs API returned HTTP 503."); } },
        ];
        const preview = await byName.job_feed_sync.preview({}, ctxFor(tpo));
        assert.equal(preview.summary, "Fetch the latest jobs now from DebugWithShubham and artha.link? It usually takes under a minute; existing jobs are kept if a source is down.");
        assert.deepEqual(preview.args, {});
        assert.equal(await JobSyncRun.countDocuments(), 0);

        const result = await byName.job_feed_sync.handler({}, ctxFor(tpo));
        assert.equal(result.summary, "Job feed sync finished with errors in " + (result.data.run.durationMs / 1000).toFixed(1)
            + "s: 1 new, 1 already known, 1 skipped. artha.link failed: The artha.link jobs API returned HTTP 503.");
        assert.equal(result.data.finished, true);
        assert.equal(result.data.run.trigger, "agent");
        assert.equal(result.data.run.triggeredBy.id, String(tpo._id));
        assert.deepEqual(result.ui, { panel: "tpo.job-feed", params: { runId: result.data.run.id } });

        jobSyncService.sources = [{ name: "debugwithshubham", async *fetchBatches() { throw new Error("offline"); } }];
        const failed = await byName.job_feed_sync.handler({}, ctxFor(tpo));
        assert.match(failed.summary, /^Job feed sync failed in [\d.]+s: 0 new, 0 already known, 0 skipped\. DebugWithShubham failed: offline\. Existing jobs were kept\.$/);
    });
});

describe("through /api/v1/agent-tools/execute", () => {
    const execute = (user, body) => request(app)
        .post("/api/v1/agent-tools/execute")
        .set({ Authorization: `Bearer ${agentToolToken(user)}` })
        .send(body);

    it("searches, forbids students-only tools for teachers and asks before syncing", async () => {
        const search = await execute(student, { tool: "jobs_search_market", args: { query: "analyst", limit: "3" } });
        assert.equal(search.status, 200);
        assert.equal(search.body.data.ok, true);
        assert.equal(search.body.data.tool, "jobs_search_market");
        assert.equal(search.body.data.data.jobs.length, 3);
        assert.equal(search.body.data.ui.panel, "jobs.market");

        const forbidden = await execute(teacher, { tool: "market_job_save", args: { job: "Data Analyst at Contoso" } });
        assert.equal(forbidden.body.data.ok, false);
        assert.equal(forbidden.body.data.error, "FORBIDDEN");

        const save = await execute(student, { tool: "market_job_save", args: { job: "Backend Developer at Wingtip" } });
        assert.equal(save.body.data.ok, true);
        assert.equal(await SavedJob.countDocuments({ user: student._id }), 1);

        const notFound = await execute(student, { tool: "market_job_save", args: { job: "Astronaut at Nowhere" } });
        assert.deepEqual([notFound.body.data.ok, notFound.body.data.error], [false, "NOT_FOUND"]);
        const ambiguous = await execute(student, { tool: "market_job_save", args: { job: "Data Analyst" } });
        assert.deepEqual([ambiguous.body.data.ok, ambiguous.body.data.error], [false, "AMBIGUOUS"]);

        jobSyncService.sources = [fakeSource("debugwithshubham", [{ externalId: "x", title: "SRE", company: "Acme", applyUrl: "https://acme.example/jobs/30001" }])];
        const unconfirmed = await execute(tpo, { tool: "job_feed_sync", args: {} });
        assert.equal(unconfirmed.body.data.ok, false);
        assert.equal(unconfirmed.body.data.needs_confirmation, true);
        assert.match(unconfirmed.body.data.preview, /^Fetch the latest jobs now from DebugWithShubham\?/);
        assert.equal(await JobSyncRun.countDocuments(), 0);

        const confirmed = await execute(tpo, { tool: "job_feed_sync", args: {}, confirmed: true });
        assert.equal(confirmed.body.data.ok, true);
        assert.equal(confirmed.body.data.data.finished, true);
        assert.equal(confirmed.body.data.data.run.totals.inserted, 1);

        const studentSync = await execute(student, { tool: "job_feed_sync", args: {}, confirmed: true });
        assert.equal(studentSync.body.data.error, "FORBIDDEN");
    });
});
