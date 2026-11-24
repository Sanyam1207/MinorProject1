// Turns raw jobs from any source into one clean shape with a dedupe key
// (docs/contracts/JOB-FEED.md §3.1). Ported verbatim from Matchy's
// job-normalizer.service.js.
import { JOB_TYPES, WORK_TYPES } from "./constants.js";

const MAX_LENGTHS = Object.freeze({
    externalId: 200,
    title: 300,
    company: 200,
    location: 200,
    experience: 100,
    salary: 100,
    description: 10000,
    category: 60,
});

// These query parameters only record where a click came from, so they are ignored when comparing apply URLs.
const TRACKING_PARAMS = new Set([
    "cmpid", "codes", "fbclid", "gclid", "gh_src", "hl", "iis", "iisn", "lang", "lever-origin", "lever-source",
    "ref", "ref_src", "referrer", "refid", "source", "src", "trackingid", "trk",
]);

// A short link can be reused for several different jobs, so it never identifies a job on its own.
const SHORTENER_HOSTS = new Set([
    "binary.so", "bit.ly", "buff.ly", "cutt.ly", "goo.gl", "is.gd", "linktr.ee", "lnkd.in", "ow.ly", "rb.gy",
    "shorturl.at", "t.co", "tiny.cc", "tinyurl.com",
]);

const COMPANY_SUFFIXES = new Set(["co", "corp", "corporation", "gmbh", "inc", "limited", "llc", "llp", "ltd", "plc", "private", "pvt"]);

function compact(value) {
    return String(value ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const JOB_TYPE_LOOKUP = Object.freeze({
    ...Object.fromEntries(JOB_TYPES.map((type) => [compact(type), type])),
    permanent: "full-time",
    intern: "internship",
    contractual: "contract",
    freelance: "contract",
    temporary: "contract",
});

const WORK_TYPE_LOOKUP = Object.freeze({
    ...Object.fromEntries(WORK_TYPES.map((type) => [compact(type), type])),
    inoffice: "onsite",
    office: "onsite",
    wfo: "onsite",
    wfh: "remote",
    workfromhome: "remote",
});

function cleanText(value, maxLength) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, maxLength) : null;
}

function cleanCategories(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => cleanText(value, MAX_LENGTHS.category)?.toLowerCase()).filter(Boolean))];
}

function cleanDescription(value) {
    if (typeof value !== "string") return null;
    const text = value
        .normalize("NFKC")
        .replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return text ? text.slice(0, MAX_LENGTHS.description) : null;
}

function toDate(value) {
    if (value == null || value === "") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function compareText(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

function companyKey(value) {
    const words = String(value ?? "").normalize("NFKD").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    while (words.length > 1 && COMPANY_SUFFIXES.has(words.at(-1))) words.pop();
    return words.join("");
}

function isTrackingParam(name) {
    const lowerName = name.toLowerCase();
    return lowerName.startsWith("utm_") || TRACKING_PARAMS.has(lowerName);
}

// A job identifier looks like "99497774528", "R165379", "JR337715", or part of a UUID.
function hasJobIdentifier(values) {
    return values
        .flatMap((value) => value.split(/[^A-Za-z0-9]+/))
        .some((token) => /\d{5,}/.test(token) || (token.length >= 6 && /\d/.test(token) && /[a-z]/i.test(token)));
}

function describeUrl(applyUrl) {
    const url = new URL(applyUrl);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    const params = [...url.searchParams]
        .filter(([name]) => !isTrackingParam(name))
        .sort(([nameA, valueA], [nameB, valueB]) => compareText(nameA, nameB) || compareText(valueA, valueB));
    const query = new URLSearchParams(params).toString();
    const route = /^#!?\//.test(url.hash) ? url.hash : "";
    return {
        host,
        key: `${host}${path}${query ? `?${query}` : ""}${route}`,
        identifierParts: [safeDecode(path), ...params.map(([, value]) => value), safeDecode(route)],
    };
}

export function cleanUrl(value) {
    if (typeof value !== "string") return null;
    let candidate = value.trim().replace(/:\/\/\s+/, "://").split(/\s/)[0];
    const protocolIndex = candidate.search(/h?ttps?:\/\//i);
    if (protocolIndex > 0) candidate = candidate.slice(protocolIndex);
    if (/^ttps?:\/\//i.test(candidate)) candidate = `h${candidate}`;
    if (!/^https?:\/\//i.test(candidate)) {
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(candidate)) return null;
        candidate = `https://${candidate}`;
    }
    candidate = candidate.replace(/[?&]+$/, "");

    try {
        const url = new URL(candidate);
        return url.hostname.includes(".") ? url.href : null;
    } catch {
        return null;
    }
}

export function isShortenerHost(hostname) {
    return SHORTENER_HOSTS.has(String(hostname).toLowerCase().replace(/^www\./, ""));
}

export function normalizeJobType(value) {
    return JOB_TYPE_LOOKUP[compact(value)] ?? null;
}

export function normalizeWorkType(value) {
    return WORK_TYPE_LOOKUP[compact(value)] ?? null;
}

export function buildDedupeKey({ applyUrl, title, company, source, externalId }) {
    const companyPart = companyKey(company);
    const titlePart = compact(title);

    if (applyUrl) {
        const { host, key, identifierParts } = describeUrl(applyUrl);
        if (!isShortenerHost(host) && hasJobIdentifier(identifierParts)) return `url:${key}`;
        return `url+title:${key}#${companyPart}|${titlePart}`;
    }
    if (companyPart && titlePart) return `text:${companyPart}|${titlePart}`;
    return `source:${source}:${externalId}`;
}

/**
 * Clean one raw job. Returns null (counted as skipped) without `source`,
 * `externalId`, or one of (`title`, a valid `applyUrl`).
 */
export function normalizeJob(input, { source, seenAt = new Date() }) {
    if (!input || typeof input !== "object") return null;

    const externalId = cleanText(input.externalId, MAX_LENGTHS.externalId);
    const title = cleanText(input.title, MAX_LENGTHS.title);
    const applyUrl = cleanUrl(input.applyUrl);
    if (!source || !externalId || (!title && !applyUrl)) return null;

    const company = cleanText(input.company, MAX_LENGTHS.company);
    const postedAt = toDate(input.postedAt);
    return {
        dedupeKey: buildDedupeKey({ applyUrl, title, company, source, externalId }),
        title,
        company,
        companyLogo: cleanUrl(input.companyLogo),
        location: cleanText(input.location, MAX_LENGTHS.location),
        experience: cleanText(input.experience, MAX_LENGTHS.experience),
        salary: cleanText(input.salary, MAX_LENGTHS.salary),
        jobType: normalizeJobType(input.jobType),
        workType: normalizeWorkType(input.workType),
        applyUrl,
        description: cleanDescription(input.description),
        postedAt: postedAt && postedAt < seenAt ? postedAt : seenAt,
        sources: [{ name: source, externalId }],
        categories: cleanCategories(input.categories),
    };
}
