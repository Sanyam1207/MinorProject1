// Turns a WhatsApp channel post into job inputs (docs/contracts/JOB-FEED.md §11.2–11.3).
// Ported from Matchy's whatsapp-job-extractor.service.js. With a TPO/admin's saved
// BYOK key the post is read by an LLM; without one, simple rules are used.
import { User } from "../../../models/user.models.js";
import { getJobFeedConfig } from "../config.js";
import { cleanUrl, isShortenerHost } from "../normalizer.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;
const HAS_URL = /\bhttps?:\/\/|\bwww\./i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_~'"]+$/;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const JOB_KEYWORDS = /\b(?:hiring|hire|jobs?|intern(?:ship)?s?|vacanc(?:y|ies)|openings?|positions?|roles?|apply|applications?|recruit(?:ment|ing)?|freshers?|off[\s-]?campus|walk[\s-]?ins?|ctc|stipend|batch(?:es)?|referrals?|careers?|engineers?|developers?|analysts?|sdet?|trainees?|programmers?|designers?|scientists?|associates?|consultants?)\b/i;
const NOT_A_COMPANY = /^(?:we|they|i|you|our\s+team|team|company)$/i;
const ANNOUNCEMENT_LINE = /^(?:(?:we|they)(?:'re|\s+are)?\s+)?(?:urgent(?:ly)?\s+)?(?:hiring|jobs?|careers?|exciting)(?:\s+(?:alert|update|opportunit(?:y|ies)|now|news))?[\s!.]*$/i;
const MAX_REDIRECTS = 5;
const REDIRECT_TIMEOUT_MS = 8_000;
const MAX_JOBS_PER_POST = 20;
// Waits before retrying an LLM call that failed for a temporary reason, such as "high demand".
export const LLM_RETRY_DELAYS_MS = Object.freeze([5_000, 20_000]);
const LLM_ROLES = ["tpo", "admin"];

export const EXTRACTION_PROMPT = `You read posts from WhatsApp job channels and extract the job openings they announce.
Reply with JSON only, in exactly this shape:
{"jobs":[{"title":string|null,"company":string|null,"location":string|null,"experience":string|null,"salary":string|null,"jobType":"full-time"|"part-time"|"internship"|"contract"|null,"workType":"onsite"|"remote"|"hybrid"|null,"applyUrl":string|null}]}
Rules:
- Add one entry per distinct job opening. One post can list several companies or roles.
- If the post does not announce a job or internship opening (ads, courses, tips, memes, requests for referrals), reply {"jobs":[]}.
- Use only what the post says. Use null for anything missing. Never invent companies, links, or salaries.
- Use null instead of placeholders such as "Not disclosed", "N/A", or "As per industry standards".
- Copy applyUrl exactly from the post, choosing the link that belongs to that opening.
- experience can be years of experience or eligible batches, for example "0-2 years" or "Batch 2024/2025".
- Keep titles short, without emojis or hashtags.`;

// Labels that job posts commonly use, such as "Role: SDE-1" or "Batch - 2025".
const FIELD_LABELS = [
    ["company", /^(?:company(?:\s+name)?|organi[sz]ation|employer|hiring\s+company)$/i],
    ["title", /^(?:role|job\s+role|position|job\s+position|job\s+title|title|designation|post|profile|opening)$/i],
    ["location", /^(?:location|job\s+location|work\s+location|place|city)$/i],
    ["experience", /^(?:experience|exp|batch(?:es)?|eligible\s+batch(?:es)?|eligibility|passing\s+year|passout|year\s+of\s+passing|graduation\s+year)$/i],
    ["salary", /^(?:salary|ctc|stipend|package|pay|compensation)$/i],
    ["applyUrl", /^(?:apply(?:\s+(?:link|here|now))?|link|application\s+link|registration\s+link)$/i],
];

const defaultFetch = (...args) => globalThis.fetch(...args);

function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Rate limits, provider overloads, timeouts, and network errors are worth retrying. A bad key or retired model is not.
export function isTemporaryFailure(error) {
    return error?.statusCode === 429 || error?.statusCode >= 500 || ["TimeoutError", "AbortError", "TypeError"].includes(error?.name);
}

function rawUrl(match) {
    return match.replace(TRAILING_PUNCTUATION, "");
}

// Removes WhatsApp formatting characters (outside links) and leading emojis or bullets.
function cleanLine(line) {
    return line
        .split(/(\bhttps?:\/\/\S+|\bwww\.\S+)/i)
        .map((part, index) => (index % 2 ? part : part.replace(/[*_~`]/g, "")))
        .join("")
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .trim();
}

function cleanTitle(value) {
    const title = value.replace(/[*_~`#]/g, "").replace(/[^\p{L}\p{N})\]]+$/u, "").trim();
    return title ? title.slice(0, 120) : null;
}

export function findUrls(text) {
    const urls = [];
    for (const [match] of text.matchAll(URL_PATTERN)) {
        const url = cleanUrl(rawUrl(match));
        if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
}

export function looksLikeJobPost(text, urls = findUrls(text)) {
    return text.trim().length >= 20 && JOB_KEYWORDS.test(text) && (urls.length > 0 || EMAIL_PATTERN.test(text));
}

// Follows redirects only while they stay on link shorteners, so the job site itself is never requested.
export async function expandUrl(url, fetchImpl = defaultFetch) {
    let current = url;
    for (let hop = 0; hop < MAX_REDIRECTS && isShortenerHost(new URL(current).hostname); hop += 1) {
        try {
            const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS) });
            await response.body?.cancel?.();
            const location = response.headers.get("location");
            if (response.status < 300 || response.status >= 400 || !location) return current;
            const next = cleanUrl(new URL(location, current).href);
            if (!next) return current;
            current = next;
        } catch {
            return current;
        }
    }
    return current;
}

export async function expandLinks(text, fetchImpl = defaultFetch) {
    const expanded = new Map();
    for (const [match] of text.matchAll(URL_PATTERN)) {
        const raw = rawUrl(match);
        if (expanded.has(raw)) continue;
        const url = cleanUrl(raw);
        expanded.set(raw, url ? await expandUrl(url, fetchImpl) : null);
    }
    const expandedText = text.replace(URL_PATTERN, (match) => {
        const raw = rawUrl(match);
        return expanded.get(raw) ? `${expanded.get(raw)}${match.slice(raw.length)}` : match;
    });
    return { text: expandedText, urls: [...new Set([...expanded.values()].filter(Boolean))] };
}

function detectJobType(text) {
    if (/\bintern(?:ship)?s?\b/i.test(text)) return "internship";
    if (/\bcontract(?:ual)?\b/i.test(text)) return "contract";
    if (/\bpart[\s-]?time\b/i.test(text)) return "part-time";
    if (/\bfull[\s-]?time\b/i.test(text)) return "full-time";
    return null;
}

function detectWorkType(text) {
    if (/\bhybrid\b/i.test(text)) return "hybrid";
    if (/\bremote\b|\bwfh\b|\bwork\s+from\s+home\b/i.test(text)) return "remote";
    if (/\bon[\s-]?site\b|\bwfo\b|\bwork\s+from\s+office\b/i.test(text)) return "onsite";
    return null;
}

function detectExperience(text) {
    const years = text.match(/\b(\d{1,2}\s*(?:-|–|to)\s*\d{1,2}|\d{1,2}\+?)\s*(?:years?|yrs?)\b/i);
    if (years) return `${years[1].replace(/\s+/g, " ")} years`;
    const batch = text.match(/\bbatch(?:es)?\s*[:\-–]?\s*(20\d\d(?:\s*[,/&-]\s*20\d\d)*)/i);
    if (batch) return `Batch ${batch[1].replace(/\s+/g, "")}`;
    return /\bfreshers?\b/i.test(text) ? "Freshers" : null;
}

// Used when no LLM key is available. Reads "Label: value" lines and a few common phrasings.
export function extractWithRules(text, urls) {
    const lines = text.split("\n").map(cleanLine).filter(Boolean);
    const fields = {};
    for (const segment of lines.flatMap((line) => line.split(/\s+\|\s+/))) {
        const match = segment.match(/^(\p{L}[\p{L} ]{0,30}?)\s*[:：\-–—]\s*(.+)$/u);
        if (!match) continue;
        const label = match[1].trim();
        const field = FIELD_LABELS.find(([, pattern]) => pattern.test(label))?.[0];
        if (!field || fields[field]) continue;
        const value = match[2].trim();
        fields[field] = field === "experience" && !/^exp/i.test(label) ? `${label} ${value}` : value;
    }

    const hiring = lines.map((line) => line.match(/^(.{2,60}?)\s+(?:is|are)\s+hiring\b(?:\s+for)?\s*[:\-–]?\s*(.*)$/i)).find(Boolean);
    const hiringFor = text.match(/\bhiring\s*(?:for\s*|:\s*|[-–]\s*)(.{2,80})/i);
    const firstLine = lines.find((line) => !HAS_URL.test(line) && !ANNOUNCEMENT_LINE.test(line))?.split(/,\s/)[0];
    const title = [fields.title, hiring?.[2], hiringFor?.[1], firstLine].map((value) => value && cleanTitle(value)).find(Boolean) ?? null;
    const hiringCompany = hiring && cleanTitle(hiring[1]);
    const applyUrl = (fields.applyUrl && findUrls(fields.applyUrl)[0]) || urls[0] || null;
    if (!title && !applyUrl) return [];

    return [{
        title,
        company: textOrNull(fields.company) || (hiringCompany && !NOT_A_COMPANY.test(hiringCompany) ? hiringCompany : null),
        location: textOrNull(fields.location),
        experience: textOrNull(fields.experience) || detectExperience(text),
        salary: textOrNull(fields.salary),
        jobType: detectJobType(text),
        workType: detectWorkType(text),
        applyUrl,
    }];
}

// The LLM may only point at links that are really in the post.
function matchPostUrl(value, urls) {
    const url = cleanUrl(typeof value === "string" ? value : "");
    if (url && urls.includes(url)) return url;
    return urls.length === 1 ? urls[0] : null;
}

export function parseLlmJobs(content, urls) {
    const raw = content !== null && typeof content === "object" ? JSON.stringify(content) : String(content ?? "");
    const json = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    const start = json.search(/[[{]/);
    const end = Math.max(json.lastIndexOf("}"), json.lastIndexOf("]"));
    if (start < 0 || end < start) throw new Error("The LLM did not reply with JSON.");

    const parsed = JSON.parse(json.slice(start, end + 1));
    const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
    if (!Array.isArray(jobs)) throw new Error("The LLM reply has no jobs list.");
    return jobs
        .filter((job) => job && typeof job === "object")
        .slice(0, MAX_JOBS_PER_POST)
        .map((job) => ({
            title: textOrNull(job.title),
            company: textOrNull(job.company),
            location: textOrNull(job.location),
            experience: textOrNull(job.experience),
            salary: textOrNull(job.salary),
            jobType: textOrNull(job.jobType),
            workType: textOrNull(job.workType),
            applyUrl: matchPostUrl(job.applyUrl, urls),
        }))
        .filter((job) => job.title || job.applyUrl);
}

const defaultImportByok = () => import("../../byok/index.js");

/**
 * The LLM client for extraction, from a TPO/admin's saved BYOK key (a student's
 * key is never spent on feed ingestion). `model` overrides the key's saved model.
 * @returns {Promise<{client: object, description: string} | {client: null, reason: string}>}
 */
export async function loadLlmClient({ email, provider, model, importByok = defaultImportByok } = {}) {
    const config = getJobFeedConfig();
    const wantedEmail = textOrNull(email === undefined ? config.whatsappLlmEmail : email)?.toLowerCase() ?? null;
    const wantedProvider = textOrNull(provider === undefined ? config.whatsappLlmProvider : provider)?.toLowerCase() ?? null;
    const wantedModel = textOrNull(model === undefined ? config.whatsappLlmModel : model);

    let byok = null;
    try {
        byok = await importByok();
    } catch {
        byok = null;
    }
    const { decryptApiKey, GenericLlmClient } = byok || {};
    if (typeof decryptApiKey !== "function" || typeof GenericLlmClient !== "function") {
        return { client: null, reason: "the BYOK module is not available" };
    }

    let user;
    if (wantedEmail) {
        user = await User.findOne({ email: wantedEmail, role: { $in: LLM_ROLES } }).select("+llmCredentials email role");
        if (!user) return { client: null, reason: `no TPO or admin account has the email ${wantedEmail}` };
    } else {
        const users = await User.find({ role: { $in: LLM_ROLES }, "llmCredentials.0": { $exists: true } })
            .select("+llmCredentials email role")
            .limit(2);
        if (users.length === 0) return { client: null, reason: "no TPO or admin account has saved an LLM key yet" };
        if (users.length > 1) return { client: null, reason: "several TPO/admin accounts have LLM keys, so set WHATSAPP_LLM_EMAIL" };
        [user] = users;
    }

    const credentials = Array.isArray(user.llmCredentials) ? user.llmCredentials : [];
    const credential = wantedProvider
        ? credentials.find((item) => item.provider === wantedProvider)
        : credentials[0];
    if (!credential) return { client: null, reason: `${user.email} has no saved ${wantedProvider || "LLM"} key` };

    try {
        const apiKey = await decryptApiKey(credential.encryptedApiKey);
        const client = new GenericLlmClient(credential.provider, apiKey, wantedModel || credential.model || undefined);
        const modelName = client.model || wantedModel || credential.model || "default model";
        return { client, description: `${credential.provider} (${modelName}) from ${user.email}` };
    } catch (error) {
        return { client: null, reason: `the saved ${credential.provider} key could not be used: ${error?.message || error}` };
    }
}

export class WhatsAppJobExtractor {
    constructor({ llmClient = null, fetchImpl = defaultFetch, retryDelaysMs = LLM_RETRY_DELAYS_MS } = {}) {
        this.llmClient = llmClient;
        this.fetch = fetchImpl;
        this.retryDelaysMs = retryDelaysMs;
    }

    async askLlm(messages) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return (await this.llmClient.complete(messages, { jsonMode: true })).content;
            } catch (error) {
                if (attempt >= this.retryDelaysMs.length || !isTemporaryFailure(error)) throw error;
                await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt]));
            }
        }
    }

    async extract(postText) {
        const text = String(postText ?? "").normalize("NFKC");
        if (!looksLikeJobPost(text)) return { jobs: [], extractedWith: null, reason: "It has no job words, or no link or email to apply." };

        const { text: expandedText, urls } = await expandLinks(text, this.fetch);
        if (!this.llmClient) {
            return { jobs: extractWithRules(expandedText, urls), extractedWith: "rules", reason: "The rules found no job title or link." };
        }

        const content = await this.askLlm([
            { role: "system", content: EXTRACTION_PROMPT },
            { role: "user", content: expandedText },
        ]);
        return { jobs: parseLlmJobs(content, urls), extractedWith: "llm", reason: "The LLM found no job openings in it." };
    }
}
