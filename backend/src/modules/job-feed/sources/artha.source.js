// artha.link job board (docs/contracts/JOB-FEED.md §4). Ported verbatim from
// Matchy; constructor defaults come from getJobFeedConfig(). An undocumented
// internal API that may break; no credentials (the portal id/slug below are
// public identifiers of the creator page whose job board is read).
import { getJobFeedConfig, parseList } from "../config.js";

export { parseList };

const JOBS_API_URL = "https://artha.link/api/job-api/recommend?pulse_variant=pulse";
// The artha.link creator page whose job board we read. Every job also has a public page there, used as its apply link.
const PORTAL_ID = "6a9598fdcbb055a6ea128fea";
const PORTAL_SLUG = "placerohq";
// 100 is the most the API returns per page.
const PAGE_SIZE = 100;
const MAX_PAGES_PER_KEYWORD = 20;
const REQUEST_TIMEOUT_MS = 30_000;

// Each keyword is searched on its own, which reaches more jobs than one combined search, and is also a category the website filters by.
// Override them with ARTHA_KEYWORDS, a comma-separated list.
export const DEFAULT_KEYWORDS = Object.freeze([
    "developer", "engineer", "data-analyst", "cyber-security", "product", "design", "sales", "marketing", "finance",
    "accounting", "banking", "operations", "supply-chain", "hr", "legal", "healthcare", "education", "content", "media",
    "customer-support", "consulting", "research", "administration", "manufacturing", "hospitality",
]);
const WORD_ENDINGS = ["ations", "ation", "ments", "ment", "ings", "ing", "ers", "er", "ions", "ion", "es", "e", "s"];

const HTML_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " });
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stem(word) {
    const ending = WORD_ENDINGS.find((suffix) => word.endsWith(suffix) && word.length - suffix.length >= 4);
    return ending ? word.slice(0, -ending.length) : word;
}

// The API's search is loose: asking for "sales" also returns ABAP developers. So a job gets a keyword as a category only
// when its title or artha's own labels mention every word of it, whichever search found the job. Endings are ignored,
// so "accounting" matches "Accountant" and "developer" matches "Software Development".
export function keywordMatcher(keyword) {
    const patterns = keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        .map((word) => new RegExp(`(^|[^a-z0-9])${stem(word)}`));
    return (job) => {
        const labels = [job.title, ...[job.category, job.enriched_category, job.keywords].flatMap((list) => (Array.isArray(list) ? list : []))];
        const haystack = labels.filter((label) => typeof label === "string").join(" | ").toLowerCase();
        return patterns.length > 0 && patterns.every((pattern) => pattern.test(haystack));
    };
}

function countryName(code) {
    try {
        return regionNames.of(code.toUpperCase()) || code;
    } catch {
        return code;
    }
}

function decodeEntity(match, entity) {
    if (entity[0] !== "#") return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

// Descriptions are HTML. The website and the resume tailoring both expect plain text.
export function htmlToText(html) {
    if (typeof html !== "string") return null;
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n• ")
        .replace(/<\/(p|div|h[1-6]|ul|ol|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity);
}

// "Bangalore" stays "Bangalore", and a job outside the searched country also names its country.
function formatLocation({ city, state, country }, homeCountry) {
    const parts = [];
    if (text(city)) parts.push(text(city));
    if (text(state) && !parts.some((part) => part.toLowerCase().includes(text(state).toLowerCase()))) parts.push(text(state));
    if (text(country) && text(country).toUpperCase() !== homeCountry) parts.push(countryName(text(country)));
    return parts.join(", ") || null;
}

function formatExperience({ exp_min: min, exp_max: max, exp_unit: unit }) {
    const label = text(unit) || "years";
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    if (hasMin && hasMax) return min === max ? `${min} ${label}` : `${min} - ${max} ${label}`;
    if (hasMin && min > 0) return `${min}+ ${label}`;
    if (hasMax) return `Up to ${max} ${label}`;
    return null;
}

function formatSalary({ salary_min: min, salary_max: max, salary_currency: currency, salary_curr: fallbackCurrency, salary_unit: unit }) {
    const code = text(currency) || text(fallbackCurrency);
    const amount = (value) => value.toLocaleString(code === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 });
    const hasMin = Number.isFinite(min) && min > 0;
    const hasMax = Number.isFinite(max) && max > 0;
    let range;
    if (hasMin && hasMax) range = min === max ? amount(min) : `${amount(min)}-${amount(max)}`;
    else if (hasMin) range = `${amount(min)}+`;
    else if (hasMax) range = `Up to ${amount(max)}`;
    else return null;
    return [code, range, text(unit) && `per ${text(unit)}`].filter(Boolean).join(" ");
}

// The API sends times without an offset. They are read as UTC.
function parseUtcTime(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const time = value.trim();
    return /T\d{2}:\d{2}/.test(time) && !/(z|[+-]\d{2}:?\d{2})$/i.test(time) ? `${time}Z` : time;
}

// The API's own `url` is a signed redirect that expires within hours, so the job's artha.link page is stored instead.
function applyUrl(slug) {
    return text(slug) ? `https://artha.link/@${PORTAL_SLUG}/jobs/${encodeURIComponent(text(slug))}` : null;
}

function toJobInput(job, { matchers, homeCountry }) {
    return {
        externalId: job.id,
        title: job.title,
        company: job.company,
        companyLogo: job.logo,
        location: formatLocation(job, homeCountry),
        experience: formatExperience(job),
        salary: formatSalary(job),
        jobType: job.job_type,
        workType: job.work_mode,
        applyUrl: applyUrl(job.slug),
        description: htmlToText(job.description),
        postedAt: parseUtcTime(job.posted_date),
        categories: matchers.filter(({ matches }) => matches(job)).map(({ keyword }) => keyword),
    };
}

export class ArthaJobSource {
    constructor({
        fetchImpl = (...args) => globalThis.fetch(...args),
        keywords = getJobFeedConfig().arthaKeywords,
        location = getJobFeedConfig().arthaLocation,
        countries = getJobFeedConfig().arthaCountries,
    } = {}) {
        this.name = "artha";
        this.fetch = fetchImpl;
        const keywordList = Array.isArray(keywords) ? keywords : parseList(keywords);
        this.keywords = keywordList.length ? keywordList : DEFAULT_KEYWORDS;
        this.location = text(location)?.toUpperCase() || "IN";
        // ARTHA_COUNTRIES keeps only jobs in these countries, for example "IN". Empty keeps every job the API returns.
        const countryList = Array.isArray(countries) ? countries : parseList(countries);
        this.countries = new Set(countryList.map((country) => String(country).toUpperCase()));
    }

    keepsCountry(country) {
        return !this.countries.size || !text(country) || this.countries.has(text(country).toUpperCase());
    }

    async *fetchBatches() {
        const matchers = this.keywords.map((keyword) => ({ keyword, matches: keywordMatcher(keyword) }));
        for (const keyword of this.keywords) {
            for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page += 1) {
                const { items, hasMore } = await this.fetchPage({ keyword, page });
                yield items
                    .filter((job) => job && typeof job === "object" && this.keepsCountry(job.country))
                    .map((job) => toJobInput(job, { matchers, homeCountry: this.location }));
                if (!hasMore || !items.length) break;
            }
        }
    }

    async fetchPage({ keyword, page }) {
        const response = await this.fetch(JOBS_API_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                query: "",
                portal_id: PORTAL_ID,
                legacy_portal_id: PORTAL_SLUG,
                geo_boost: true,
                page,
                limit: PAGE_SIZE,
                location: this.location,
                only_enriched: false,
                only_cpa: false,
                categories: [keyword],
                niche_keywords: [keyword],
                dedup_by: "content_hash",
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`The artha.link jobs API returned HTTP ${response.status}.`);
        const body = await response.json();
        if (!Array.isArray(body?.items)) throw new Error("The artha.link jobs API returned an invalid response.");
        return { items: body.items, hasMore: body.has_more === true };
    }
}
