// WhatsApp channels for the job feed (docs/contracts/JOB-FEED.md §11, §16.1 tests 26–30).
// Ported from Matchy's test/whatsapp.test.js: no network, fake LLM clients, fake BYOK.
// "baileys" is optional: tests that need the real library skip when it is absent.
import { connectTestDb, disconnectTestDb, createUser } from "./helpers.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalJob } from "../src/modules/job-feed/models/external-job.model.js";
import { WhatsAppAuthState } from "../src/modules/job-feed/models/whatsapp-auth-state.model.js";
import { WhatsAppPost } from "../src/modules/job-feed/models/whatsapp-post.model.js";
import { toPublicJob } from "../src/modules/job-feed/feed.service.js";
import { JobSyncService } from "../src/modules/job-feed/sync.service.js";
import { loadBaileys } from "../src/modules/job-feed/whatsapp/baileys.js";
import { parseChannelList, toChannelPost } from "../src/modules/job-feed/whatsapp/channel.source.js";
import {
    clearMongoAuthState,
    UNDECRYPTABLE_LOGIN_MESSAGE,
    useMongoAuthState,
} from "../src/modules/job-feed/whatsapp/auth-state.service.js";
import {
    expandUrl,
    extractWithRules,
    findUrls,
    loadLlmClient,
    looksLikeJobPost,
    parseLlmJobs,
    WhatsAppJobExtractor,
} from "../src/modules/job-feed/whatsapp/job-extractor.service.js";
import { BAILEYS_MISSING_REASON, startWhatsAppListener } from "../src/modules/job-feed/whatsapp/listener.service.js";
import { WhatsAppPostService } from "../src/modules/job-feed/whatsapp/post.service.js";
import { getWhatsAppStatus, resetWhatsAppStatus } from "../src/modules/job-feed/whatsapp/status.js";

const realFetch = globalThis.fetch;
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "120363000000000001@newsletter";
const AMAZON_POST = `🚀 *𝗔𝗺𝗮𝘇𝗼𝗻 𝗛𝗶𝗿𝗶𝗻𝗴 𝗔𝗹𝗲𝗿𝘁* 🚀

🏢 Company: Amazon
💼 Role: SDE-1
🎓 Batch: 2024/2025
📍 Location: Bangalore
💰 CTC: 18-32 LPA

👉 Apply here: https://www.amazon.jobs/en/jobs/3200436/software-dev-engineer?utm_source=whatsapp.`;

const lib = await loadBaileys();
const silentLog = { log() {}, warn() {}, error() {} };

before(async () => {
    globalThis.fetch = async () => {
        throw new Error("network disabled in tests");
    };
    await connectTestDb("job_feed_whatsapp");
});

after(async () => {
    globalThis.fetch = realFetch;
    resetWhatsAppStatus();
    await disconnectTestDb();
});

beforeEach(async () => {
    const { User } = await import("../src/models/user.models.js");
    await Promise.all([ExternalJob.deleteMany({}), User.deleteMany({}), WhatsAppPost.deleteMany({}), WhatsAppAuthState.deleteMany({})]);
});

function redirectFetch(redirects) {
    const requests = [];
    const fetchImpl = async (url) => {
        requests.push(url);
        const location = redirects[url];
        return { status: location ? 301 : 200, headers: new Headers(location ? { location } : {}) };
    };
    return { fetchImpl, requests };
}

function fakeLlm(reply) {
    const calls = [];
    return {
        calls,
        async complete(messages) {
            calls.push(messages);
            return { content: typeof reply === "function" ? reply(messages) : reply };
        },
    };
}

function channelPost(overrides = {}) {
    return {
        channelJid: CHANNEL,
        channelName: "Tech Jobs",
        messageId: "msg-1",
        text: AMAZON_POST,
        postedAt: new Date("2026-10-01T10:00:00Z"),
        ...overrides,
    };
}

describe("channel posts and extraction", () => {
    it("parseChannelList accepts channel links, invite codes, channel IDs, and all", () => {
        assert.deepEqual(
            parseChannelList("https://whatsapp.com/channel/0029VaAbCdEfGhIjKlMnOp12, 120363000000000001@newsletter 0029VaZyXwVuTsRqPoNmLk34,oops"),
            {
                all: false,
                jids: ["120363000000000001@newsletter"],
                inviteCodes: ["0029VaAbCdEfGhIjKlMnOp12", "0029VaZyXwVuTsRqPoNmLk34"],
                invalid: ["oops"],
            },
        );
        assert.equal(parseChannelList("all").all, true);
        assert.deepEqual(parseChannelList(undefined), { all: false, jids: [], inviteCodes: [], invalid: [] });
    });

    it("toChannelPost reads channel posts and ignores everything else", { skip: !lib && "baileys is not installed" }, () => {
        const post = toChannelPost({
            key: { remoteJid: CHANNEL, id: "ABC", fromMe: false },
            message: { ephemeralMessage: { message: { extendedTextMessage: { text: "  Hiring SDE interns  " } } } },
            messageTimestamp: 1792598400,
        }, lib);
        assert.deepEqual(post, {
            channelJid: CHANNEL,
            messageId: "ABC",
            text: "Hiring SDE interns",
            postedAt: new Date(1792598400 * 1000),
        });

        assert.equal(toChannelPost({ key: { remoteJid: CHANNEL, id: "IMG" }, message: { imageMessage: { caption: "Role: QA" } } }, lib).text, "Role: QA");
        assert.equal(toChannelPost({ key: { remoteJid: "919999999999@s.whatsapp.net", id: "DM" }, message: { conversation: "hi" } }, lib), null);
        assert.equal(toChannelPost({ key: { remoteJid: CHANNEL, id: "MINE", fromMe: true }, message: { conversation: "hi" } }, lib), null);
        assert.equal(toChannelPost({ key: { remoteJid: CHANNEL, id: "EDIT" }, message: { protocolMessage: { type: 14 } } }, lib), null);
        assert.equal(toChannelPost({ key: { remoteJid: CHANNEL, id: "X" }, message: { conversation: "hi" } }, null), null);
    });

    it("findUrls and looksLikeJobPost spot job posts with a way to apply", () => {
        assert.deepEqual(findUrls("Apply: *https://bit.ly/abc123*, or www.acme.com/jobs/12345."), [
            "https://bit.ly/abc123",
            "https://www.acme.com/jobs/12345",
        ]);
        assert.equal(looksLikeJobPost(AMAZON_POST.normalize("NFKC")), true);
        assert.equal(looksLikeJobPost("We are hiring a Backend Developer. Send your resume to careers@acme.io"), true);
        assert.equal(looksLikeJobPost("Good morning! Join our free course today: https://example.com/course"), false);
        assert.equal(looksLikeJobPost("Hiring now, DM me for details"), false);
    });

    it("expandUrl follows short links but never requests the job site", async () => {
        const { fetchImpl, requests } = redirectFetch({
            "https://bit.ly/abc123": "https://tinyurl.com/xyz789",
            "https://tinyurl.com/xyz789": "https://job-boards.greenhouse.io/acme/jobs/4979430101?gh_src=whatsapp",
        });

        assert.equal(await expandUrl("https://bit.ly/abc123", fetchImpl), "https://job-boards.greenhouse.io/acme/jobs/4979430101?gh_src=whatsapp");
        assert.deepEqual(requests, ["https://bit.ly/abc123", "https://tinyurl.com/xyz789"]);

        assert.equal(await expandUrl("https://acme.com/jobs/12345", fetchImpl), "https://acme.com/jobs/12345");
        assert.equal(requests.length, 2);
        assert.equal(await expandUrl("https://bit.ly/no-redirect", fetchImpl), "https://bit.ly/no-redirect");
        assert.equal(await expandUrl("https://bit.ly/offline", async () => { throw new Error("offline"); }), "https://bit.ly/offline");
        // The default fetch is the (disabled) global one: a short link is kept as it is.
        assert.equal(await expandUrl("https://bit.ly/abc123"), "https://bit.ly/abc123");
    });

    it("extractWithRules reads labelled posts and common phrasings", () => {
        const text = AMAZON_POST.normalize("NFKC");
        assert.deepEqual(extractWithRules(text, findUrls(text)), [{
            title: "SDE-1",
            company: "Amazon",
            location: "Bangalore",
            experience: "Batch 2024/2025",
            salary: "18-32 LPA",
            jobType: null,
            workType: null,
            applyUrl: "https://www.amazon.jobs/en/jobs/3200436/software-dev-engineer?utm_source=whatsapp",
        }]);

        const google = "Google is hiring for Software Engineer Intern!\nRemote | Batch 2026\nhttps://careers.google.com/jobs/results/105569610505298630";
        const [job] = extractWithRules(google, findUrls(google));
        assert.deepEqual([job.title, job.company, job.jobType, job.workType, job.experience], ["Software Engineer Intern", "Google", "internship", "remote", "Batch 2026"]);

        const [weAreHiring] = extractWithRules("We are hiring!\nBackend Developer (Node.js), 0-2 years, Hybrid\nMail careers@acme.io", []);
        assert.deepEqual([weAreHiring.title, weAreHiring.company, weAreHiring.experience], ["Backend Developer (Node.js)", null, "0-2 years"]);
    });

    it("parseLlmJobs keeps only links that are really in the post", () => {
        const urls = ["https://acme.com/jobs/11111", "https://beta.io/careers/22222"];
        const jobs = parseLlmJobs(`\`\`\`json
{"jobs":[
  {"title":"SDE Intern","company":"Acme","applyUrl":"https://acme.com/jobs/11111","jobType":"internship"},
  {"title":"QA Engineer","company":"Beta","applyUrl":"https://made-up.example/apply"},
  {"title":null,"company":null,"applyUrl":null}
]}
\`\`\``, urls);

        assert.equal(jobs.length, 2);
        assert.deepEqual([jobs[0].title, jobs[0].applyUrl, jobs[0].jobType], ["SDE Intern", "https://acme.com/jobs/11111", "internship"]);
        assert.equal(jobs[1].applyUrl, null);
        assert.equal(parseLlmJobs('[{"title":"Analyst","applyUrl":"https://wrong.example"}]', ["https://acme.com/jobs/11111"])[0].applyUrl, "https://acme.com/jobs/11111");
        assert.equal(parseLlmJobs({ jobs: [{ title: "Analyst" }] }, [])[0].title, "Analyst");
        assert.throws(() => parseLlmJobs("Sorry, I can't help with that.", urls), /did not reply with JSON/);
    });

    it("the extractor asks the LLM only about likely job posts, with short links expanded", async () => {
        const { fetchImpl } = redirectFetch({ "https://bit.ly/acme": "https://acme.com/jobs/11111" });
        const llm = fakeLlm('{"jobs":[{"title":"SDE Intern","company":"Acme","applyUrl":"https://acme.com/jobs/11111"}]}');
        const extractor = new WhatsAppJobExtractor({ llmClient: llm, fetchImpl });

        const result = await extractor.extract("Acme is hiring SDE interns! Apply: https://bit.ly/acme");
        assert.equal(result.extractedWith, "llm");
        assert.deepEqual(result.jobs.map((job) => [job.title, job.applyUrl]), [["SDE Intern", "https://acme.com/jobs/11111"]]);
        assert.equal(llm.calls[0][0].role, "system");
        assert.match(llm.calls[0][1].content, /Apply: https:\/\/acme\.com\/jobs\/11111$/);

        const skipped = await extractor.extract("Happy Diwali to everyone in the channel!");
        assert.deepEqual([skipped.jobs.length, skipped.extractedWith], [0, null]);
        assert.equal(llm.calls.length, 1);
    });

    it("the extractor retries temporary LLM errors but not permanent ones", async () => {
        const post = "Acme is hiring SDE interns! Apply: https://acme.com/jobs/11111";
        let busyCalls = 0;
        const busyOnce = {
            async complete() {
                busyCalls += 1;
                if (busyCalls === 1) throw Object.assign(new Error("This model is currently experiencing high demand."), { statusCode: 503 });
                return { content: '{"jobs":[{"title":"SDE Intern","applyUrl":"https://acme.com/jobs/11111"}]}' };
            },
        };
        const result = await new WhatsAppJobExtractor({ llmClient: busyOnce, retryDelaysMs: [0, 0] }).extract(post);
        assert.deepEqual([busyCalls, result.jobs.length], [2, 1]);

        let retiredCalls = 0;
        const retired = {
            async complete() {
                retiredCalls += 1;
                throw Object.assign(new Error("This model is no longer available to new users."), { statusCode: 404 });
            },
        };
        await assert.rejects(new WhatsAppJobExtractor({ llmClient: retired, retryDelaysMs: [0, 0] }).extract(post), /no longer available/);
        assert.equal(retiredCalls, 1);
    });
});

describe("WhatsAppPostService", () => {
    it("retryFailed gives recent failed posts another try, within the attempt limit", async () => {
        const jobs = new JobSyncService({ sources: [] });
        const failing = new WhatsAppPostService({ extractor: { async extract() { throw new Error("busy"); } }, jobs });
        const working = new WhatsAppPostService({ extractor: new WhatsAppJobExtractor(), jobs });
        const now = new Date("2026-10-03T10:00:00Z");
        await failing.handle(channelPost({ messageId: "fresh", postedAt: new Date("2026-10-02T10:00:00Z") }));
        await failing.handle(channelPost({ messageId: "too-old", postedAt: new Date("2026-09-20T10:00:00Z") }));
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await failing.handle(channelPost({ messageId: "worn-out", postedAt: new Date("2026-10-02T10:00:00Z") }));
        }

        const capped = await working.retryFailed({ maxAttempts: 5, now });
        assert.deepEqual(capped.map(({ post, outcome }) => [post.messageId, outcome.status]), [["fresh", "saved"]]);

        const uncapped = await working.retryFailed({ now });
        assert.deepEqual(uncapped.map(({ post, outcome }) => [post.messageId, outcome.status]), [["worn-out", "saved"]]);

        const records = Object.fromEntries((await WhatsAppPost.find()).map((record) => [record.messageId, [record.status, record.attempts]]));
        assert.deepEqual(records, { fresh: ["saved", 2], "too-old": ["failed", 1], "worn-out": ["saved", 6] });
    });

    it("a channel post becomes jobs once, even if WhatsApp delivers it again", async () => {
        let extractions = 0;
        const extractor = {
            async extract(text) {
                extractions += 1;
                return new WhatsAppJobExtractor().extract(text);
            },
        };
        const service = new WhatsAppPostService({ extractor, jobs: new JobSyncService({ sources: [] }) });

        const first = await service.handle(channelPost());
        const again = await service.handle(channelPost());

        assert.deepEqual([first.status, first.jobCount, first.newJobCount, first.extractedWith], ["saved", 1, 1, "rules"]);
        assert.equal(again, null);
        assert.equal(extractions, 1);

        const job = await ExternalJob.findOne();
        assert.deepEqual(
            [job.title, job.company, job.description, job.postedAt.toISOString(), job.isSample],
            ["SDE-1", "Amazon", AMAZON_POST.normalize("NFKC"), "2026-10-01T10:00:00.000Z", false],
        );
        assert.deepEqual(job.sources.map((source) => [source.name, source.externalId]), [["whatsapp", `${CHANNEL}:msg-1:0`]]);
        const record = await WhatsAppPost.findOne();
        assert.deepEqual([record.status, record.channelName, record.text], ["saved", "Tech Jobs", AMAZON_POST]);
    });

    it("a WhatsApp post about a job that is already saved adds a source instead of a duplicate", async () => {
        const jobs = new JobSyncService({ sources: [] });
        await jobs.ingest("debugwithshubham", [{
            externalId: "feed-1",
            title: "Software Development Engineer I",
            company: "Amazon",
            applyUrl: "https://www.amazon.jobs/en/jobs/3200436/software-dev-engineer",
        }]);

        const result = await new WhatsAppPostService({ extractor: new WhatsAppJobExtractor(), jobs }).handle(channelPost());

        assert.deepEqual([result.jobCount, result.newJobCount], [1, 0]);
        const saved = await ExternalJob.find();
        assert.equal(saved.length, 1);
        assert.deepEqual(toPublicJob(saved[0]).sources, ["debugwithshubham", "whatsapp"]);
        // The feed had no description; the WhatsApp post fills it in.
        assert.equal(saved[0].description, AMAZON_POST.normalize("NFKC"));
    });

    it("failed posts are recorded and tried again on the next delivery", async () => {
        let failNext = true;
        const extractor = {
            async extract(text) {
                if (failNext) throw new Error("The LLM provider rejected the request.");
                return new WhatsAppJobExtractor().extract(text);
            },
        };
        const service = new WhatsAppPostService({ extractor, jobs: new JobSyncService({ sources: [] }) });

        const failed = await service.handle(channelPost());
        assert.deepEqual([failed.status, failed.error], ["failed", "The LLM provider rejected the request."]);

        failNext = false;
        const retried = await service.handle(channelPost());
        assert.equal(retried.status, "saved");
        const record = await WhatsAppPost.findOne();
        assert.deepEqual([record.status, record.error], ["saved", undefined]);
        assert.equal(await WhatsAppPost.countDocuments(), 1);
    });

    it("posts that are not jobs are recorded as ignored", async () => {
        const service = new WhatsAppPostService({ extractor: new WhatsAppJobExtractor(), jobs: new JobSyncService({ sources: [] }) });

        const result = await service.handle(channelPost({ messageId: "msg-2", text: "Good morning everyone! Stay consistent." }));

        assert.deepEqual([result.status, result.jobCount], ["ignored", 0]);
        assert.match(result.reason, /no job words/);
        assert.equal(await ExternalJob.countDocuments(), 0);
    });
});

describe("loadLlmClient", () => {
    class FakeClient {
        constructor(provider, apiKey, model) {
            this.provider = provider;
            this.apiKey = apiKey;
            this.model = model ?? "provider-default";
        }
    }
    const fakeByok = () => Promise.resolve({ decryptApiKey: (value) => value.replace(/^enc:/, ""), GenericLlmClient: FakeClient });
    // Empty strings (not undefined) keep the WHATSAPP_LLM_* environment variables out of the test.
    const options = (overrides = {}) => ({ email: "", provider: "", model: "", importByok: fakeByok, ...overrides });
    const key = (provider, apiKey, model) => ({ provider, encryptedApiKey: `enc:${apiKey}`, ...(model ? { model } : {}) });

    it("uses a TPO's or admin's saved key and never a student's", async () => {
        assert.equal((await loadLlmClient(options())).reason, "no TPO or admin account has saved an LLM key yet");

        const student = await createUser({ role: "student", email: "student@demo.edu", llmCredentials: [key("openai", "sk-student-000000")] });
        assert.equal((await loadLlmClient(options())).reason, "no TPO or admin account has saved an LLM key yet");
        assert.equal((await loadLlmClient(options({ email: student.email }))).reason, "no TPO or admin account has the email student@demo.edu");

        await createUser({ role: "tpo", email: "tpo@demo.edu", llmCredentials: [key("openai", "sk-test-123456", "gpt-4o-mini")] });
        const loaded = await loadLlmClient(options());
        assert.equal(loaded.client.apiKey, "sk-test-123456");
        assert.equal(loaded.description, "openai (gpt-4o-mini) from tpo@demo.edu");
        assert.equal((await loadLlmClient(options({ model: "gpt-5-mini" }))).client.model, "gpt-5-mini");
        assert.equal((await loadLlmClient(options({ provider: "anthropic" }))).reason, "tpo@demo.edu has no saved anthropic key");
        assert.equal((await loadLlmClient(options({ email: "someone@demo.edu" }))).reason, "no TPO or admin account has the email someone@demo.edu");

        await createUser({ role: "admin", email: "admin@demo.edu", llmCredentials: [key("google", "google-key-1234")] });
        assert.equal((await loadLlmClient(options())).reason, "several TPO/admin accounts have LLM keys, so set WHATSAPP_LLM_EMAIL");
        const admin = await loadLlmClient(options({ email: "Admin@Demo.edu" }));
        assert.deepEqual([admin.client.provider, admin.client.apiKey, admin.description], ["google", "google-key-1234", "google (provider-default) from admin@demo.edu"]);
    });

    it("degrades gracefully when the BYOK module or the key cannot be used", async () => {
        await createUser({ role: "tpo", email: "tpo2@demo.edu", llmCredentials: [key("openai", "sk-test-123456")] });
        const failedImport = await loadLlmClient(options({ importByok: () => Promise.reject(new Error("Cannot find module")) }));
        assert.deepEqual(failedImport, { client: null, reason: "the BYOK module is not available" });
        const missingExports = await loadLlmClient(options({ importByok: async () => ({ default: { name: "byok" } }) }));
        assert.equal(missingExports.reason, "the BYOK module is not available");

        const broken = await loadLlmClient(options({
            importByok: async () => ({ decryptApiKey: () => { throw new Error("bad key material"); }, GenericLlmClient: FakeClient }),
        }));
        assert.equal(broken.reason, "the saved openai key could not be used: bad key material");
    });
});

describe("encrypted WhatsApp login", { skip: !lib && "baileys is not installed" }, () => {
    it("is stored encrypted and survives a restart with Buffers intact", async () => {
        const first = await useMongoAuthState(lib, { log: silentLog });
        first.state.creds.registered = true;
        await first.saveCreds();
        await first.state.keys.set({
            "pre-key": { 1: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) }, 2: null },
            session: { "123@s.whatsapp.net": Buffer.from("session") },
        });

        const raw = await WhatsAppAuthState.find().lean();
        assert.ok(raw.length >= 3);
        for (const doc of raw) {
            assert.match(doc.value, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
            assert.equal(doc.value.includes("noiseKey"), false);
            assert.equal(doc.value.includes("Buffer"), false);
        }

        // A new process reads the same login back, Buffers included.
        const second = await useMongoAuthState(lib, { log: silentLog });
        assert.equal(second.state.creds.registered, true);
        assert.deepEqual(second.state.creds.noiseKey.public, first.state.creds.noiseKey.public);
        const keys = await second.state.keys.get("pre-key", ["1", "2"]);
        assert.ok(Buffer.isBuffer(keys["1"].public));
        assert.deepEqual([...keys["1"].private], [4, 5, 6]);
        assert.equal(keys["2"], null);

        await second.state.keys.set({ "pre-key": { 1: null } });
        assert.equal((await second.state.keys.get("pre-key", ["1"]))["1"], null);

        await clearMongoAuthState();
        assert.equal(await WhatsAppAuthState.countDocuments(), 0);
        assert.equal((await useMongoAuthState(lib, { log: silentLog })).state.creds.registered, false);
    });

    it("treats a value that cannot be decrypted as missing and says so once", async () => {
        await WhatsAppAuthState.create({ _id: "creds", value: "00:11:22" });
        await WhatsAppAuthState.create({ _id: "pre-key-1", value: "not-encrypted" });
        const warnings = [];
        const log = { ...silentLog, warn: (message) => warnings.push(message) };
        const state = await useMongoAuthState(lib, { log });
        assert.equal(state.state.creds.registered, false);
        assert.deepEqual(await state.state.keys.get("pre-key", ["1"]), { 1: null });
        assert.deepEqual(warnings, [`WhatsApp: ${UNDECRYPTABLE_LOGIN_MESSAGE}`]);
        await clearMongoAuthState();
    });
});

describe("optional baileys", () => {
    it("startWhatsAppListener resolves as unavailable when baileys cannot be loaded", async () => {
        resetWhatsAppStatus();
        const warnings = [];
        const listener = await startWhatsAppListener({
            importBaileys: () => Promise.reject(new Error("Cannot find package 'baileys'")),
            log: { ...silentLog, warn: (message) => warnings.push(message) },
        });
        assert.equal(listener.available, false);
        await listener.stop();
        const status = getWhatsAppStatus();
        assert.equal(status.state, "unavailable");
        assert.equal(status.reason, BAILEYS_MISSING_REASON);
        assert.equal(status.reason, "The optional \"baileys\" package is not installed, so WhatsApp channels are off.");
        assert.deepEqual(warnings, [`WhatsApp: ${BAILEYS_MISSING_REASON}`]);
        resetWhatsAppStatus();
    });

    it("no file under src/ imports baileys statically; only whatsapp/baileys.js imports it at all", () => {
        const srcDir = path.join(BACKEND_DIR, "src");
        const files = [];
        const walk = (dir) => {
            for (const name of readdirSync(dir)) {
                const full = path.join(dir, name);
                if (statSync(full).isDirectory()) walk(full);
                else if (/\.(c|m)?js$/.test(name)) files.push(full);
            }
        };
        walk(srcDir);
        const staticImport = /(?:\bfrom\s*["']baileys(?:\/[^"']*)?["']|\bimport\s*["']baileys(?:\/[^"']*)?["']|\brequire\(\s*["']baileys)/;
        const anyImport = /\bimport\(\s*["']baileys(?:\/[^"']*)?["']\s*\)/;
        const offenders = files.filter((file) => staticImport.test(readFileSync(file, "utf8")));
        assert.deepEqual(offenders, []);
        const dynamic = files.filter((file) => anyImport.test(readFileSync(file, "utf8"))).map((file) => path.relative(srcDir, file));
        assert.deepEqual(dynamic, [path.join("modules", "job-feed", "whatsapp", "baileys.js")]);
    });

    it("import(src/app.js) works without baileys and never loads it", () => {
        const script = `
            import module from "node:module";
            let requested = false;
            if (typeof module.registerHooks === "function") {
                module.registerHooks({
                    resolve(specifier, context, nextResolve) {
                        if (specifier === "baileys" || specifier.startsWith("baileys/")) {
                            requested = true;
                            throw Object.assign(new Error("Cannot find package 'baileys'"), { code: "ERR_MODULE_NOT_FOUND" });
                        }
                        return nextResolve(specifier, context);
                    },
                });
            }
            await import("./src/app.js");
            const loadedAtImport = requested;
            const { loadBaileys } = await import("./src/modules/job-feed/whatsapp/baileys.js");
            const lib = await loadBaileys();
            console.log(JSON.stringify({ hooks: typeof module.registerHooks === "function", loadedAtImport, lib: lib === null ? null : "loaded" }));
            process.exit(0);
        `;
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            cwd: BACKEND_DIR,
            env: { ...process.env, NODE_ENV: "test" },
            encoding: "utf8",
            timeout: 60_000,
        });
        assert.equal(child.status, 0, child.stderr);
        const line = child.stdout.trim().split("\n").filter((entry) => entry.startsWith("{")).pop();
        const result = JSON.parse(line);
        assert.equal(result.loadedAtImport, false);
        if (result.hooks) assert.equal(result.lib, null);
    });

    it("an invalid TOKEN_ENCRYPTION_KEY makes the listener unavailable", { skip: !lib && "baileys is not installed" }, () => {
        const script = `
            const { startWhatsAppListener } = await import("./src/modules/job-feed/whatsapp/listener.service.js");
            const { getWhatsAppStatus } = await import("./src/modules/job-feed/whatsapp/status.js");
            const silent = { log() {}, warn() {}, error() {} };
            await startWhatsAppListener({ log: silent });
            console.log(JSON.stringify(getWhatsAppStatus()));
            process.exit(0);
        `;
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            cwd: BACKEND_DIR,
            env: { ...process.env, NODE_ENV: "test", TOKEN_ENCRYPTION_KEY: "too-short" },
            encoding: "utf8",
            timeout: 60_000,
        });
        assert.equal(child.status, 0, child.stderr);
        const status = JSON.parse(child.stdout.trim().split("\n").filter((entry) => entry.startsWith("{")).pop());
        assert.equal(status.state, "unavailable");
        assert.equal(status.reason, "TOKEN_ENCRYPTION_KEY (64 hex chars) is required to store the WhatsApp login.");
    });
});
