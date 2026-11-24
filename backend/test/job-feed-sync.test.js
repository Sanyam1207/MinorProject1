// Job feed: normalisation, dedupe, sources, the sync service, offline behaviour,
// sample listings, helpers and notifications (docs/contracts/JOB-FEED.md §16.1, tests 1–14).
// Ported from Matchy's test/jobs.test.js. No network: every source gets a fetch stub
// and the global fetch throws.
import { connectTestDb, disconnectTestDb, createUser } from "./helpers.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { getJobFeedConfig } from "../src/modules/job-feed/config.js";
import { toPublicJob } from "../src/modules/job-feed/feed.service.js";
import { ExternalJob } from "../src/modules/job-feed/models/external-job.model.js";
import { JobSyncRun } from "../src/modules/job-feed/models/job-sync-run.model.js";
import { SavedJob } from "../src/modules/job-feed/models/saved-job.model.js";
import { buildDedupeKey, cleanUrl, normalizeJob } from "../src/modules/job-feed/normalizer.js";
import { seedSampleExternalJobs, SAMPLE_EXTERNAL_JOBS } from "../src/modules/job-feed/sample-jobs.js";
import { ArthaJobSource } from "../src/modules/job-feed/sources/artha.source.js";
import { DebugWithShubhamJobSource } from "../src/modules/job-feed/sources/debug-with-shubham.source.js";
import {
    INTERRUPTED_RUN_ERROR,
    JobSyncService,
    jobSyncService,
    markInterruptedRuns,
    purgeStaleJobs,
    shouldRunBootSync,
} from "../src/modules/job-feed/sync.service.js";
import { upsertSavedJob } from "../src/modules/job-feed/tracker.service.js";
import jobFeedModule, { runBootSyncIfStale, seedSampleJobs } from "../src/modules/job-feed/index.js";
import "../src/modules/notifications/models.js";

const realFetch = globalThis.fetch;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

before(async () => {
    globalThis.fetch = async () => {
        throw new Error("network disabled in tests");
    };
    await connectTestDb("job_feed_sync");
});

after(async () => {
    globalThis.fetch = realFetch;
    jobSyncService.sources = null;
    await disconnectTestDb();
});

beforeEach(async () => {
    const { User } = await import("../src/models/user.models.js");
    await Promise.all([
        ExternalJob.deleteMany({}),
        SavedJob.deleteMany({}),
        JobSyncRun.deleteMany({}),
        mongoose.models.Notification.deleteMany({}),
        User.deleteMany({}),
    ]);
});

function feedJob(overrides = {}) {
    return {
        id: "feed-1",
        company_name: "Barclays ",
        company_logo: "https://res.cloudinary.com/demo/barclays.png",
        role: "Full Stack Engineer",
        location: "Pune",
        experience: "0 - 2 years",
        salary: "",
        apply_url: "https://search.jobs.barclays/job/-/-/13015/99497774528?",
        job_type: "FullTime",
        work_type: "Onsite",
        posted_at: "2026-09-22T19:06:00",
        ...overrides,
    };
}

function feedSource(pagesByJobType) {
    const requests = [];
    const fetchImpl = async (url) => {
        const params = new URL(url).searchParams;
        requests.push(`${params.get("jobType")}:${params.get("page")}:${params.get("limit")}`);
        const jobs = pagesByJobType[params.get("jobType")]?.[Number(params.get("page")) - 1] ?? [];
        return { ok: true, status: 200, json: async () => jobs };
    };
    return { source: new DebugWithShubhamJobSource({ fetchImpl }), requests };
}

function arthaJob(overrides = {}) {
    return {
        id: "artha-1",
        title: "Software Development Engineer",
        slug: "software-development-engineer-acme-bengaluru-1a2b3c4d",
        company: "Acme",
        logo: "https://cdn.example.com/acme.png",
        url: "https://r.artha.link/redirect/2178_536501?country=IN&expires=1792863505&signature=deadbeef",
        city: "Bengaluru",
        state: "Karnataka",
        country: "IN",
        posted_date: "2026-10-21T15:00:27",
        exp_min: 2,
        exp_max: 4,
        exp_unit: "years",
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_curr: null,
        salary_unit: null,
        job_type: "full-time",
        work_mode: "onsite",
        description: "<p><strong>The Role</strong></p><ol><li>Build APIs &amp; services</li><li>Ship weekly</li></ol>",
        category: ["IT / Computing / Software"],
        enriched_category: [],
        keywords: [],
        ...overrides,
    };
}

function arthaSource(pagesByKeyword, options = {}) {
    const requests = [];
    const fetchImpl = async (_url, { body }) => {
        const { niche_keywords: [keyword], page, limit } = JSON.parse(body);
        requests.push(`${keyword}:${page}:${limit}`);
        const pages = pagesByKeyword[keyword] ?? [];
        return { ok: true, status: 200, json: async () => ({ items: pages[page - 1] ?? [], has_more: page < pages.length }) };
    };
    return { source: new ArthaJobSource({ fetchImpl, keywords: Object.keys(pagesByKeyword), ...options }), requests };
}

const usAttorney = arthaJob({
    id: "artha-us",
    title: "Litigation Attorney",
    slug: "litigation-attorney-micro1-f70691ed",
    company: "micro1",
    city: null,
    state: null,
    country: "US",
    exp_min: null,
    exp_max: null,
    exp_unit: null,
    salary_min: 50,
    salary_max: 100,
    salary_currency: "USD",
    salary_unit: "hour",
    job_type: "contract",
    work_mode: "remote",
    category: [],
    keywords: ["Legal"],
});

function fakeSource(name, batches, { failAfterBatch } = {}) {
    return {
        name,
        async *fetchBatches() {
            for (const [index, batch] of batches.entries()) {
                if (index === failAfterBatch) throw new Error("The feed is down.");
                yield batch;
            }
        },
    };
}

const throwingSource = (name, message = "getaddrinfo ENOTFOUND feed.example") => ({
    name,
    // eslint-disable-next-line require-yield
    async *fetchBatches() {
        throw new Error(message);
    },
});

const notificationsOf = (type) => mongoose.models.Notification.find({ type }).lean();

describe("normalizer (ported)", () => {
    it("cleans messy source values", () => {
        const job = normalizeJob({
            externalId: 42,
            title: "  𝗦𝗗𝗘-𝟭   𝗕𝗮𝗰𝗸𝗲𝗻𝗱 ",
            company: "Infosys ",
            applyUrl: ":https://redhat.wd5.myworkdayjobs.com/jobs/job/Pune/SRE-Intern_R-058641?",
            jobType: "FullTime",
            workType: "Work from home",
            salary: "",
            postedAt: "2026-10-21T13:11:00Z",
        }, { source: "feed", seenAt: new Date("2026-10-22T00:00:00Z") });

        assert.equal(job.title, "SDE-1 Backend");
        assert.equal(job.company, "Infosys");
        assert.equal(job.applyUrl, "https://redhat.wd5.myworkdayjobs.com/jobs/job/Pune/SRE-Intern_R-058641");
        assert.equal(job.jobType, "full-time");
        assert.equal(job.workType, "remote");
        assert.equal(job.salary, null);
        assert.equal(job.postedAt.toISOString(), "2026-10-21T13:11:00.000Z");
        assert.deepEqual(job.sources, [{ name: "feed", externalId: "42" }]);
    });

    it("rejects unusable jobs and never dates a job in the future", () => {
        assert.equal(normalizeJob({ externalId: "1", company: "Acme" }, { source: "feed" }), null);
        assert.equal(normalizeJob({ title: "SDE", applyUrl: "https://acme.com/jobs/12345" }, { source: "feed" }), null);
        assert.equal(normalizeJob({ externalId: "1", title: "SDE" }, { source: "" }), null);

        const seenAt = new Date("2026-10-21T10:00:00Z");
        const job = normalizeJob({ externalId: "1", title: "SDE", postedAt: "2027-01-01T00:00:00Z" }, { source: "feed", seenAt });
        assert.equal(job.postedAt.toISOString(), seenAt.toISOString());
        const invalid = normalizeJob({ externalId: "1", title: "SDE", postedAt: "not a date" }, { source: "feed", seenAt });
        assert.equal(invalid.postedAt.toISOString(), seenAt.toISOString());
    });

    it("cleanUrl repairs broken apply links and rejects non-web links", () => {
        assert.equal(cleanUrl("ttps://juspay.io/careers/DEV-BE01"), "https://juspay.io/careers/DEV-BE01");
        assert.equal(cleanUrl("https:// qnance.com/about-us/fpga-programmer/"), "https://qnance.com/about-us/fpga-programmer/");
        assert.equal(cleanUrl("www.example.com/jobs/12345"), "https://www.example.com/jobs/12345");
        assert.equal(cleanUrl("https://acme.com/jobs/1?&"), "https://acme.com/jobs/1");
        assert.equal(cleanUrl("mailto:hr@example.com"), null);
        assert.equal(cleanUrl("not a link"), null);
        assert.equal(cleanUrl(""), null);
    });

    it("dedupe keys ignore tracking noise and reworded titles but keep different jobs apart", () => {
        const key = (applyUrl, title, company) => buildDedupeKey({ applyUrl, title, company, source: "feed", externalId: "1" });

        assert.equal(
            key("http://job-boards.greenhouse.io/commerceiq/jobs/7636728003?gh_src=w08vs0k03us", "SDE I", "CommerceIQ"),
            key("https://www.job-boards.greenhouse.io/commerceiq/jobs/7636728003/?utm_source=whatsapp", "Software Engineer I", "CommerceQ"),
        );
        assert.notEqual(
            key("https://careers.cisco.com/global/en/job/CISCISGLOBAL2009687EXTERNALENGLOBAL/Software-Engineer", "Software Engineer", "Cisco"),
            key("https://careers.cisco.com/global/en/job/CISCISGLOBAL2009686EXTERNALENGLOBAL/Software-Engineer", "Software Engineer", "Cisco"),
        );

        // Generic careers pages and short links are shared by many jobs, so the title decides.
        assert.equal(key("https://careers.swiggy.com/", "SDE II", "Swiggy"), key("https://careers.swiggy.com", "SDE II", "Swiggy"));
        assert.notEqual(key("https://careers.swiggy.com", "SDE I", "Swiggy"), key("https://careers.swiggy.com", "SDE II", "Swiggy"));
        assert.notEqual(key("https://binary.so/ekU3WhT", "ASE Backend", "MyGate"), key("https://binary.so/ekU3WhT", "ASE Frontend", "MyGate"));

        // Without a link, company and title decide, ignoring legal suffixes.
        assert.equal(
            buildDedupeKey({ title: "Data Entry Intern", company: "RevNet LLC", source: "a", externalId: "1" }),
            buildDedupeKey({ title: "data entry intern", company: "RevNet", source: "b", externalId: "2" }),
        );
        assert.equal(buildDedupeKey({ title: "SDE Intern", source: "whatsapp", externalId: "msg-1" }), "source:whatsapp:msg-1");
    });
});

describe("sync service", () => {
    it("syncing the same feed twice does not create duplicates", async () => {
        const { source } = feedSource({
            FullTime: [[
                feedJob(),
                feedJob({ id: "feed-2", role: "Data Engineer", apply_url: "https://amazon.jobs/en/jobs/3200436/data-engineer-i" }),
            ]],
        });
        const service = new JobSyncService({ sources: [source] });

        const first = await service.sync();
        const second = await service.sync();

        assert.deepEqual([first.results[0].inserted, first.results[0].duplicates, first.results[0].error], [2, 0, null]);
        assert.deepEqual([second.results[0].inserted, second.results[0].duplicates, second.results[0].error], [0, 2, null]);
        assert.equal(first.status, "ok");
        assert.equal(first.results[0].label, "DebugWithShubham");
        assert.equal(await ExternalJob.countDocuments(), 2);

        const job = await ExternalJob.findOne({ title: "Full Stack Engineer" });
        assert.equal(job.company, "Barclays");
        assert.equal(job.applyUrl, "https://search.jobs.barclays/job/-/-/13015/99497774528");
        assert.equal(job.jobType, "full-time");
        assert.equal(job.workType, "onsite");
        assert.equal(job.salary, undefined);
        assert.equal(job.isSample, false);
        assert.equal(job.postedAt.toISOString(), "2026-09-22T13:36:00.000Z");
        assert.equal(await JobSyncRun.countDocuments({ status: "ok" }), 2);
    });

    it("merges reposts into one job that keeps the newest posting date", async () => {
        const service = new JobSyncService({ sources: [] });
        const repost = (externalId, title, postedAt) => ({
            externalId,
            title,
            company: "Barclays",
            applyUrl: "https://search.jobs.barclays/job/-/-/13015/99497774528",
            postedAt,
        });

        const firstBatch = await service.ingest("feed", [
            repost("new", "Full Stack Engineer", "2026-09-23T13:05:00Z"),
            repost("old", "Full Stack Engineer (Pune)", "2026-09-22T13:36:00Z"),
        ]);
        await service.ingest("feed", [repost("older", "Full Stack Engineer", "2026-09-01T00:00:00Z")]);
        await service.ingest("feed", [repost("newest", "Full Stack Engineer", "2026-10-01T00:00:00Z")]);

        assert.deepEqual([firstBatch.inserted, firstBatch.duplicates, firstBatch.insertedIds.length], [1, 1, 1]);
        const jobs = await ExternalJob.find();
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].title, "Full Stack Engineer");
        assert.equal(jobs[0].postedAt.toISOString(), "2026-10-01T00:00:00.000Z");
        assert.deepEqual(jobs[0].sources.map((source) => source.externalId).sort(), ["new", "newest", "old", "older"]);
    });

    it("stores the same job from two sources once and lists both sources", async () => {
        const service = new JobSyncService({ sources: [] });
        await service.ingest("debugwithshubham", [{
            externalId: "feed-1",
            title: "Full Stack Engineer",
            company: "Barclays",
            applyUrl: "https://search.jobs.barclays/job/-/-/13015/99497774528",
        }]);
        const fromWhatsApp = await service.ingest("whatsapp", [{
            externalId: "120363000000000000@newsletter:42",
            title: "Hiring: Full Stack Engineer",
            company: "Barclays",
            applyUrl: "https://search.jobs.barclays/job/-/-/13015/99497774528?utm_source=whatsapp",
        }]);

        assert.deepEqual([fromWhatsApp.inserted, fromWhatsApp.duplicates], [0, 1]);
        const jobs = await ExternalJob.find();
        assert.equal(jobs.length, 1);
        assert.deepEqual(toPublicJob(jobs[0]).sources, ["debugwithshubham", "whatsapp"]);
    });

    it("a failing source keeps what it saved and does not stop other sources", async () => {
        const broken = fakeSource("broken", [
            [{ externalId: "1", title: "SDE", applyUrl: "https://acme.com/jobs/12345" }],
            [{ externalId: "2", title: "QA", applyUrl: "https://acme.com/jobs/67890" }],
        ], { failAfterBatch: 1 });
        const healthy = fakeSource("healthy", [[{ externalId: "3", title: "SRE", applyUrl: "https://acme.com/jobs/24680" }]]);

        const run = await new JobSyncService({ sources: [broken, healthy] }).sync();
        const [brokenResult, healthyResult] = run.results;

        assert.deepEqual([brokenResult.inserted, brokenResult.error], [1, "The feed is down."]);
        assert.deepEqual([healthyResult.inserted, healthyResult.error], [1, null]);
        assert.equal(run.status, "partial");
        assert.deepEqual(run.totals, { received: 2, inserted: 2, duplicates: 0, skipped: 0 });
        assert.equal(await ExternalJob.countDocuments(), 2);
    });

    it("concurrent sync requests share a single run", async () => {
        let runs = 0;
        const source = {
            name: "feed",
            async *fetchBatches() {
                runs += 1;
                yield [{ externalId: "1", title: "SDE", applyUrl: "https://acme.com/jobs/12345" }];
            },
        };
        const service = new JobSyncService({ sources: [source] });

        const firstPromise = service.sync({ trigger: "manual" });
        assert.equal(service.isRunning(), true);
        assert.equal(service.current().status, "running");
        assert.equal(service.current().trigger, "manual");
        const [first, second] = await Promise.all([firstPromise, service.sync({ trigger: "agent" })]);

        assert.equal(runs, 1);
        assert.equal(first, second);
        assert.equal(first.trigger, "manual");
        assert.equal(service.isRunning(), false);
        assert.equal(service.current(), null);
        assert.equal(await ExternalJob.countDocuments(), 1);
    });

    it("the DebugWithShubham source pages through every job type", async () => {
        const fullTimePage = Array.from({ length: 200 }, (_, index) => feedJob({
            id: `ft-${index}`,
            apply_url: `https://acme.com/jobs/${100000 + index}`,
        }));
        const { source, requests } = feedSource({
            FullTime: [fullTimePage, [feedJob({ id: "ft-last", apply_url: "https://acme.com/jobs/999999" })]],
            Internship: [[feedJob({ id: "intern-1", job_type: "Internship", apply_url: "https://acme.com/jobs/555555" })]],
        });

        const run = await new JobSyncService({ sources: [source] }).sync();
        const [result] = run.results;

        assert.deepEqual(requests, ["FullTime:1:200", "FullTime:2:200", "Internship:1:200", "Contract:1:200"]);
        assert.deepEqual([result.received, result.inserted, result.error], [202, 202, null]);
        assert.equal(await ExternalJob.countDocuments({ jobType: "internship" }), 1);
    });

    it("the artha.link source searches every keyword, pages through results, and stores clean jobs", async () => {
        const abapDeveloper = arthaJob({ id: "artha-abap", title: "Senior Abap Developer", slug: "senior-abap-developer-abb-bangalore-908085d0", category: [] });
        const { source, requests } = arthaSource({
            developer: [
                [arthaJob()],
                [arthaJob({ id: "artha-surat", title: "Full Stack Developer", slug: "full-stack-developer-beta-surat-d9d29603", city: "Surat, Gujarat, India", state: "Gujarat" })],
            ],
            engineer: [[arthaJob()]],
            legal: [[usAttorney, abapDeveloper]],
        });
        const service = new JobSyncService({ sources: [source] });

        const [first] = (await service.sync()).results;
        const [second] = (await service.sync()).results;

        assert.deepEqual(requests.slice(0, 4), ["developer:1:100", "developer:2:100", "engineer:1:100", "legal:1:100"]);
        assert.deepEqual([first.received, first.inserted, first.duplicates, first.error], [5, 4, 1, null]);
        assert.deepEqual([second.inserted, second.duplicates], [0, 5]);
        assert.equal(first.label, "artha.link");

        const engineer = await ExternalJob.findOne({ title: "Software Development Engineer" });
        assert.equal(engineer.applyUrl, "https://artha.link/@placerohq/jobs/software-development-engineer-acme-bengaluru-1a2b3c4d");
        assert.equal(engineer.location, "Bengaluru, Karnataka");
        assert.equal(engineer.experience, "2 - 4 years");
        assert.equal(engineer.salary, undefined);
        assert.deepEqual([engineer.jobType, engineer.workType], ["full-time", "onsite"]);
        assert.equal(engineer.description, "The Role\n\n• Build APIs & services\n• Ship weekly");
        assert.equal(engineer.postedAt.toISOString(), "2026-10-21T15:00:27.000Z");
        assert.deepEqual([...engineer.categories].sort(), ["developer", "engineer"]);
        assert.deepEqual(toPublicJob(engineer).sources, ["artha"]);

        assert.equal((await ExternalJob.findOne({ title: "Full Stack Developer" })).location, "Surat, Gujarat, India");

        const attorney = await ExternalJob.findOne({ title: "Litigation Attorney" });
        assert.deepEqual([attorney.location, attorney.salary, attorney.jobType, attorney.workType], ["United States", "USD 50-100 per hour", "contract", "remote"]);
        assert.deepEqual([...attorney.categories], ["legal"]);

        // The legal search returned it, but nothing about the job mentions legal work.
        assert.deepEqual([...(await ExternalJob.findOne({ title: "Senior Abap Developer" })).categories], ["developer"]);
    });

    it("ARTHA_COUNTRIES keeps only jobs from the listed countries", async () => {
        const { source } = arthaSource(
            { legal: [[usAttorney, arthaJob({ title: "Corporate Legal Counsel", slug: "corporate-legal-counsel-acme-mumbai-77aa11bb" })]] },
            { countries: ["in"] },
        );

        const [result] = (await new JobSyncService({ sources: [source] }).sync()).results;

        assert.deepEqual([result.received, result.inserted], [1, 1]);
        assert.deepEqual((await ExternalJob.find()).map((job) => job.title), ["Corporate Legal Counsel"]);
    });

    it("the database refuses a second job with the same dedupe key", async () => {
        const job = { dedupeKey: "url:acme.com/jobs/12345", title: "SDE", postedAt: new Date(), lastSeenAt: new Date() };
        await ExternalJob.create(job);
        await assert.rejects(ExternalJob.create({ ...job, title: "SDE copy" }), { code: 11000 });
    });

    it("backfills fields a later source supplies, without overwriting stored values", async () => {
        const service = new JobSyncService({ sources: [] });
        const base = { title: "Backend Engineer", company: "Acme", applyUrl: "https://acme.com/jobs/77777" };
        await service.ingest("debugwithshubham", [{ ...base, externalId: "a" }]);
        let job = await ExternalJob.findOne().lean();
        assert.equal(job.description, undefined);
        assert.equal(job.location, undefined);

        await service.ingest("artha", [{ ...base, externalId: "b", description: "Build APIs in Go.", location: "Pune" }]);
        job = await ExternalJob.findOne().lean();
        assert.equal(job.description, "Build APIs in Go.");
        assert.equal(job.location, "Pune");

        await service.ingest("whatsapp", [{ ...base, externalId: "c", description: "A different description.", location: "Mumbai" }]);
        job = await ExternalJob.findOne().lean();
        assert.equal(job.description, "Build APIs in Go.");
        assert.equal(job.location, "Pune");
        assert.deepEqual(job.sources.map((source) => source.name), ["debugwithshubham", "artha", "whatsapp"]);
    });

    it("offline: every source failing resolves a failed run and changes nothing", async () => {
        await seedSampleExternalJobs();
        await new JobSyncService({ sources: [] }).ingest("debugwithshubham", [
            { externalId: "real-1", title: "SRE", company: "Acme", applyUrl: "https://acme.com/jobs/31337" },
        ]);
        const before = { jobs: await ExternalJob.countDocuments(), samples: await ExternalJob.countDocuments({ isSample: true }) };
        assert.deepEqual(before, { jobs: 17, samples: 16 });

        // The real sources, with the global fetch throwing "network disabled in tests".
        const previous = { FROM_ARTHA: process.env.FROM_ARTHA, ARTHA_KEYWORDS: process.env.ARTHA_KEYWORDS };
        process.env.FROM_ARTHA = "true";
        process.env.ARTHA_KEYWORDS = "developer";
        jobSyncService.sources = null;
        let run;
        try {
            run = await jobSyncService.sync({ trigger: "schedule" });
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }

        assert.equal(run.status, "failed");
        assert.deepEqual(run.results.map((result) => [result.source, result.error]), [
            ["debugwithshubham", "network disabled in tests"],
            ["artha", "network disabled in tests"],
        ]);
        assert.equal(run.sampleJobsRemoved, 0);
        assert.equal(await ExternalJob.countDocuments(), before.jobs);
        assert.equal(await ExternalJob.countDocuments({ isSample: true }), before.samples);
        const stored = await JobSyncRun.findById(run.id).lean();
        assert.equal(stored.status, "failed");
        assert.equal(stored.trigger, "schedule");
        assert.deepEqual(stored.results.map((result) => result.error), ["network disabled in tests", "network disabled in tests"]);
    });
});

describe("sample listings", () => {
    it("seed 16 sample jobs once; real jobs remove the unsaved ones; failed runs remove none", async () => {
        assert.equal(SAMPLE_EXTERNAL_JOBS.length, 16);
        const first = await seedSampleExternalJobs();
        assert.deepEqual(first, { inserted: 16, existing: 0 });
        const samples = await ExternalJob.find({ isSample: true }).lean();
        assert.equal(samples.length, 16);
        assert.ok(samples.every((job) => job.sources.length === 1 && job.sources[0].name === "sample"));
        assert.ok(samples.every((job) => job.applyUrl.startsWith("https://example.com/careers/")));
        assert.ok(samples.every((job) => job.description.endsWith("(Sample listing — shown so the job feed is not empty during a demo.)")));
        assert.deepEqual(await seedSampleExternalJobs(), { inserted: 0, existing: 16 });
        assert.equal(await ExternalJob.countDocuments(), 16);

        // A failed run never touches samples.
        const failed = await new JobSyncService({ sources: [throwingSource("debugwithshubham")] }).sync();
        assert.equal(failed.status, "failed");
        assert.equal(failed.sampleJobsRemoved, 0);
        assert.equal(await ExternalJob.countDocuments({ isSample: true }), 16);

        // A successful run with real jobs removes the samples nobody saved.
        const student = await createUser({ role: "student" });
        const kept = samples.find((job) => job.title === "Data Analyst Intern");
        await upsertSavedJob({ user: student, jobId: String(kept._id) });
        const ok = await new JobSyncService({
            sources: [fakeSource("debugwithshubham", [[{ externalId: "r1", title: "SDE", company: "Acme", applyUrl: "https://acme.com/jobs/12345" }]])],
        }).sync();
        assert.equal(ok.status, "ok");
        assert.equal(ok.sampleJobsRemoved, 15);
        const left = await ExternalJob.find({ isSample: true }).lean();
        assert.deepEqual(left.map((job) => String(job._id)), [String(kept._id)]);
        assert.equal((await JobSyncRun.findById(ok.id).lean()).sampleJobsRemoved, 15);
    });
});

describe("helpers", () => {
    it("shouldRunBootSync only runs when the last successful sync is stale", () => {
        const now = new Date("2026-11-25T10:00:00Z");
        const ago = (minutes) => new Date(now.getTime() - minutes * MINUTE);
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: null, now, intervalMinutes: 60 }), true);
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: { startedAt: ago(30) }, now, intervalMinutes: 60 }), false);
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: { startedAt: ago(61) }, now, intervalMinutes: 60 }), true);
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: { startedAt: ago(30) }, now, intervalMinutes: 20 }), true);
        // Interval 0 (no periodic sync) falls back to 60 minutes.
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: { startedAt: ago(45) }, now, intervalMinutes: 0 }), false);
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: { startedAt: ago(90) }, now, intervalMinutes: 0 }), true);
        // A restart right after a failed attempt does not hit the feeds again.
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: null, lastRun: { status: "failed", startedAt: ago(2) }, now, intervalMinutes: 60 }), false);
        assert.equal(shouldRunBootSync({ lastSuccessfulRun: null, lastRun: { status: "failed", startedAt: ago(15) }, now, intervalMinutes: 60 }), true);
    });

    it("start() and the boot sync never hit a feed when the last success is recent", async () => {
        await JobSyncRun.create({ trigger: "schedule", status: "running", startedAt: new Date(Date.now() - HOUR) });
        await jobFeedModule.start({ io: null });
        assert.equal(await JobSyncRun.countDocuments({ status: "running" }), 0);

        let fetched = 0;
        jobSyncService.sources = [{ name: "debugwithshubham", async *fetchBatches() { fetched += 1; yield []; } }];
        try {
            const config = { ...getJobFeedConfig(), syncIntervalMinutes: 60 };
            const first = await runBootSyncIfStale(config);
            assert.deepEqual([first.trigger, first.status, fetched], ["boot", "ok", 1]);
            assert.equal(await runBootSyncIfStale(config), null);
            assert.equal(fetched, 1);
        } finally {
            jobSyncService.sources = null;
        }
        assert.equal(seedSampleJobs, seedSampleExternalJobs);
    });

    it("getJobFeedConfig parses numbers and booleans with defaults", () => {
        assert.equal(getJobFeedConfig({}).syncIntervalMinutes, 60);
        assert.equal(getJobFeedConfig({ JOB_SYNC_INTERVAL_MINUTES: "abc" }).syncIntervalMinutes, 60);
        assert.equal(getJobFeedConfig({ JOB_SYNC_INTERVAL_MINUTES: "0" }).syncIntervalMinutes, 0);
        assert.equal(getJobFeedConfig({ JOB_SYNC_INTERVAL_MINUTES: "20000" }).syncIntervalMinutes, 60);
        assert.equal(getJobFeedConfig({ JOB_SYNC_INTERVAL_MINUTES: "15" }).syncIntervalMinutes, 15);
        assert.equal(getJobFeedConfig({ JOB_SYNC_INTERVAL_MINUTES: "1.5" }).syncIntervalMinutes, 60);
        assert.equal(getJobFeedConfig({}).retentionDays, 45);
        assert.equal(getJobFeedConfig({ JOB_FEED_RETENTION_DAYS: "0" }).retentionDays, 0);
        assert.equal(getJobFeedConfig({ JOB_FEED_RETENTION_DAYS: "7" }).retentionDays, 7);
        assert.equal(getJobFeedConfig({ JOB_FEED_RETENTION_DAYS: "-1" }).retentionDays, 45);
        assert.equal(getJobFeedConfig({ JOB_FEED_RETENTION_DAYS: "9999" }).retentionDays, 45);
        assert.equal(getJobFeedConfig({}).syncOnBoot, true);
        assert.equal(getJobFeedConfig({ JOB_SYNC_ON_BOOT: "false" }).syncOnBoot, false);
        assert.equal(getJobFeedConfig({}).fromArtha, false);
        assert.equal(getJobFeedConfig({ FROM_ARTHA: "true" }).fromArtha, true);
        assert.equal(getJobFeedConfig({}).matchDigest, true);
        assert.equal(getJobFeedConfig({ JOB_FEED_MATCH_DIGEST: "false" }).matchDigest, false);
        assert.equal(getJobFeedConfig({}).whatsappEnabled, false);
        assert.equal(getJobFeedConfig({ WHATSAPP_ENABLED: "true" }).whatsappEnabled, true);
        assert.equal(getJobFeedConfig({}).arthaLocation, "IN");
        assert.deepEqual(getJobFeedConfig({ ARTHA_COUNTRIES: "in, us,IN" }).arthaCountries, ["IN", "US"]);
        assert.deepEqual(getJobFeedConfig({ ARTHA_KEYWORDS: "Developer, legal" }).arthaKeywords, ["developer", "legal"]);
        // The test harness turns the schedule and WhatsApp off through process.env.
        assert.equal(getJobFeedConfig().syncIntervalMinutes, 0);
        assert.equal(getJobFeedConfig().whatsappEnabled, false);
    });

    it("markInterruptedRuns fails runs left running by a previous process", async () => {
        const now = new Date();
        await JobSyncRun.create({ trigger: "schedule", status: "running", startedAt: new Date(now.getTime() - HOUR) });
        await JobSyncRun.create({ trigger: "manual", status: "ok", startedAt: new Date(now.getTime() - 2 * HOUR), finishedAt: now });
        assert.equal(await markInterruptedRuns(now), 1);
        const failed = await JobSyncRun.findOne({ trigger: "schedule" }).lean();
        assert.deepEqual([failed.status, failed.error, failed.finishedAt.toISOString()], ["failed", INTERRUPTED_RUN_ERROR, now.toISOString()]);
        assert.equal(await markInterruptedRuns(now), 0);
    });

    it("purgeStaleJobs deletes old unsaved jobs and keeps saved and sample ones", async () => {
        const now = new Date();
        const old = new Date(now.getTime() - 50 * DAY);
        const make = (key, fields = {}) => ExternalJob.create({ dedupeKey: key, title: key, postedAt: old, lastSeenAt: old, ...fields });
        const stale = await make("stale");
        const saved = await make("saved");
        const sample = await make("sample", { isSample: true });
        const fresh = await make("fresh", { lastSeenAt: now });
        const student = await createUser({ role: "student" });
        await upsertSavedJob({ user: student, jobId: String(saved._id) });

        assert.deepEqual(await purgeStaleJobs({ retentionDays: 45, now }), { deleted: 1 });
        const left = (await ExternalJob.find().lean()).map((job) => job.dedupeKey).sort();
        assert.deepEqual(left, ["fresh", "sample", "saved"]);
        assert.equal(await ExternalJob.exists({ _id: stale._id }), null);
        assert.ok(sample && fresh);
        assert.deepEqual(await purgeStaleJobs({ retentionDays: 0, now }), { deleted: 0 });
    });
});

describe("notifications", () => {
    it("jobfeed.matches: one digest per matching student per day, never for samples", async () => {
        const reactStudent = await createUser({ role: "student", skills: ["React"] });
        const noSkills = await createUser({ role: "student" });
        const projectOnly = await createUser({ role: "student", projects: [{ title: "Dashboard", skills: ["react"] }] });
        const reactJob = (id) => ({
            externalId: id,
            title: "React Developer",
            company: `Acme ${id}`,
            applyUrl: `https://acme.com/jobs/${id}`,
            postedAt: new Date(),
        });

        await seedSampleExternalJobs();
        assert.equal((await notificationsOf("jobfeed.matches")).length, 0);

        const run = await new JobSyncService({ sources: [fakeSource("debugwithshubham", [[reactJob("40001")]])] }).sync();
        assert.equal(run.status, "ok");
        let notes = await notificationsOf("jobfeed.matches");
        assert.deepEqual(notes.map((note) => String(note.user)).sort(), [String(reactStudent._id), String(projectOnly._id)].sort());
        notes = notes.filter((note) => String(note.user) === String(reactStudent._id));
        assert.equal(notes[0].title, "1 new job matches your profile");
        assert.equal(notes[0].body, "React Developer at Acme 40001.");
        assert.deepEqual(notes[0].ui, { panel: "jobs.market", params: { sort: "match", highlightIds: notes[0].data.jobIds } });
        assert.equal(notes[0].data.runId, run.id);
        assert.equal(notes[0].priority, "low");
        assert.match(notes[0].dedupeKey, /^jobfeed-matches:\d{4}-\d{2}-\d{2}$/);

        await new JobSyncService({ sources: [fakeSource("debugwithshubham", [[reactJob("40002")]])] }).sync();
        notes = await notificationsOf("jobfeed.matches");
        assert.equal(notes.length, 2);
        assert.equal(notes.filter((note) => String(note.user) === String(noSkills._id)).length, 0);
    });

    it("jobfeed.sync.failed: TPOs hear once when the feed goes down", async () => {
        const tpo = await createUser({ role: "tpo" });
        const admin = await createUser({ role: "admin" });
        await createUser({ role: "tpo", isActive: false });
        await createUser({ role: "student" });

        const failing = new JobSyncService({ sources: [throwingSource("debugwithshubham", "The jobs feed returned HTTP 503.")] });
        const first = await failing.sync();
        assert.equal(first.status, "failed");
        let notes = await notificationsOf("jobfeed.sync.failed");
        assert.deepEqual(notes.map((note) => String(note.user)).sort(), [String(tpo._id), String(admin._id)].sort());
        const note = notes.find((entry) => String(entry.user) === String(tpo._id));
        assert.equal(note.title, "Job feed sync failed");
        assert.equal(
            note.body,
            "No source could be reached (DebugWithShubham: The jobs feed returned HTTP 503). Existing jobs are kept; automatic syncing is off (JOB_SYNC_INTERVAL_MINUTES=0).",
        );
        assert.deepEqual(note.ui, { panel: "tpo.job-feed", params: { runId: first.id } });
        assert.deepEqual(note.data, { runId: first.id });

        const second = await failing.sync();
        assert.equal(second.status, "failed");
        notes = await notificationsOf("jobfeed.sync.failed");
        assert.equal(notes.length, 2);
    });
});
