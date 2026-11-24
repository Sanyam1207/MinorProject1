// DebugWithShubham jobs feed (docs/contracts/JOB-FEED.md §4). Ported verbatim
// from Matchy. A third-party feed with no SLA and no credentials.
const JOBS_API_URL = "https://debugwithshubham-web-page.onrender.com/api/jobs/";
const FEED_JOB_TYPES = ["FullTime", "Internship", "Contract"];
const PAGE_SIZE = 200;
const MAX_PAGES_PER_JOB_TYPE = 25;
// The feed is hosted on Render, which can take close to a minute to wake up.
const REQUEST_TIMEOUT_MS = 60_000;

// The feed sends Indian wall-clock times without an offset, for example "2026-10-21T18:41:00".
function parseIndiaTime(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    const hasTime = /T\d{2}:\d{2}/.test(text);
    const hasOffset = /(z|[+-]\d{2}:?\d{2})$/i.test(text);
    return hasTime && !hasOffset ? `${text}+05:30` : text || null;
}

function toJobInput(job) {
    return {
        externalId: job.id,
        title: job.role,
        company: job.company_name,
        companyLogo: job.company_logo,
        location: job.location,
        experience: job.experience,
        salary: job.salary,
        jobType: job.job_type,
        workType: job.work_type,
        applyUrl: job.apply_url,
        postedAt: parseIndiaTime(job.posted_at),
    };
}

export class DebugWithShubhamJobSource {
    constructor({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
        this.name = "debugwithshubham";
        this.fetch = fetchImpl;
    }

    async *fetchBatches() {
        for (const jobType of FEED_JOB_TYPES) {
            for (let page = 1; page <= MAX_PAGES_PER_JOB_TYPE; page += 1) {
                const jobs = await this.fetchPage({ jobType, page });
                yield jobs.filter((job) => job && typeof job === "object").map(toJobInput);
                if (jobs.length < PAGE_SIZE) break;
            }
        }
    }

    async fetchPage({ jobType, page }) {
        const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), jobType });
        const response = await this.fetch(`${JOBS_API_URL}?${query}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`The jobs feed returned HTTP ${response.status}.`);
        const jobs = await response.json();
        if (!Array.isArray(jobs)) throw new Error("The jobs feed returned an invalid response.");
        return jobs;
    }
}
