// Demo listings so the open-market feed is never empty offline
// (docs/contracts/JOB-FEED.md §14). Companies are fictional demo brands and every
// apply link is on example.com (RFC 2606). The module never seeds by itself: the
// demo seed script calls seedSampleExternalJobs(). Once real jobs arrive, a sync
// removes the samples nobody saved (sync.service.js removeUnsavedSampleJobs).
import { SAMPLE_SOURCE } from "./constants.js";
import { ExternalJob } from "./models/external-job.model.js";
import { SavedJob } from "./models/saved-job.model.js";
import { jobSyncService } from "./sync.service.js";

const HOUR_MS = 60 * 60 * 1000;
const SAMPLE_NOTE = "(Sample listing — shown so the job feed is not empty during a demo.)";

const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const sample = ({ id, title, company, location, jobType, workType, experience, salary, categories, summary, hoursAgo }) => ({
    externalId: `sample-${id}`,
    title,
    company,
    companyLogo: null,
    location,
    experience,
    salary,
    jobType,
    workType,
    applyUrl: `https://example.com/careers/${slugify(title)}-${id}`,
    description: `${summary} ${SAMPLE_NOTE}`,
    categories,
    hoursAgo,
});

/** The 16 raw sample inputs (postedAt is derived from `hoursAgo` when seeding). */
export const SAMPLE_EXTERNAL_JOBS = Object.freeze([
    sample({
        id: 100001, title: "Software Engineer Intern", company: "Contoso Labs", location: "Bengaluru",
        jobType: "internship", workType: "hybrid", experience: "Batch 2026/2027", salary: "₹40,000/month stipend",
        categories: ["developer", "engineer"], hoursAgo: 6,
        summary: "Join the platform team to build internal services in Java and Spring Boot. You will write SQL against production-like data and ship code reviewed through Git pull requests.",
    }),
    sample({
        id: 100002, title: "Frontend Developer", company: "Tailspin Software", location: "Pune",
        jobType: "full-time", workType: "onsite", experience: "0-2 years", salary: "₹6-9 LPA",
        categories: ["developer"], hoursAgo: 20,
        summary: "Build customer-facing dashboards with React, JavaScript and TypeScript. You will own reusable components and keep the CSS design system consistent across products.",
    }),
    sample({
        id: 100003, title: "Backend Developer (Node.js)", company: "Wingtip Cloud", location: "Remote",
        jobType: "full-time", workType: "remote", experience: "1-3 years", salary: "₹8-12 LPA",
        categories: ["developer", "engineer"], hoursAgo: 30,
        summary: "Design REST APIs with Node.js and Express backed by MongoDB. You will containerise services with Docker and help the team keep latency low.",
    }),
    sample({
        id: 100004, title: "Data Analyst Intern", company: "Northwind Analytics", location: "Gurugram",
        jobType: "internship", workType: "hybrid", experience: "Freshers", salary: "₹25,000/month stipend",
        categories: ["data-analyst"], hoursAgo: 10,
        summary: "Turn sales data into weekly insights using SQL, Excel and Python. You will build Power BI dashboards that the operations team reviews every Monday.",
    }),
    sample({
        id: 100005, title: "Machine Learning Engineer", company: "Trey Research", location: "Hyderabad",
        jobType: "full-time", workType: "hybrid", experience: "0-2 years", salary: "₹12-18 LPA",
        categories: ["engineer", "research"], hoursAgo: 48,
        summary: "Train and evaluate models in Python and PyTorch for document understanding. Experience with Machine Learning fundamentals and NLP pipelines is expected.",
    }),
    sample({
        id: 100006, title: "UI/UX Design Intern", company: "Adventure Works Digital", location: "Mumbai",
        jobType: "internship", workType: "onsite", experience: "Freshers", salary: "₹20,000/month stipend",
        categories: ["design"], hoursAgo: 72,
        summary: "Design app flows in Figma with the product team. You will run quick UI/UX reviews and turn ideas into clickable Prototyping sessions with real users.",
    }),
    sample({
        id: 100007, title: "Cloud Support Associate", company: "Litware Systems", location: "Noida",
        jobType: "full-time", workType: "onsite", experience: "0-1 years", salary: "₹5-7 LPA",
        categories: ["operations", "engineer"], hoursAgo: 96,
        summary: "Help customers run workloads on AWS and troubleshoot Linux servers. Basic Networking knowledge (DNS, TCP/IP, load balancers) is required.",
    }),
    sample({
        id: 100008, title: "Product Management Intern", company: "Proseware Inc", location: "Bengaluru",
        jobType: "internship", workType: "hybrid", experience: "Batch 2026", salary: "₹35,000/month stipend",
        categories: ["product"], hoursAgo: 120,
        summary: "Work with a product manager on the onboarding funnel. You will query usage data with SQL, track work in Jira and present Product analytics findings to the team.",
    }),
    sample({
        id: 100009, title: "Financial Analyst", company: "Woodgrove Bank", location: "Mumbai",
        jobType: "full-time", workType: "onsite", experience: "0-2 years", salary: "₹7-10 LPA",
        categories: ["finance", "banking"], hoursAgo: 150,
        summary: "Support the corporate finance team with monthly reporting in Excel. You will build Financial Modeling templates and reconcile figures with Accounting.",
    }),
    sample({
        id: 100010, title: "Digital Marketing Associate", company: "Fourth Coffee", location: "Delhi",
        jobType: "full-time", workType: "onsite", experience: "0-1 years", salary: "₹4-6 LPA",
        categories: ["marketing"], hoursAgo: 170,
        summary: "Grow organic traffic through SEO and measure campaigns in Google Analytics. You will plan Content calendars with the brand team.",
    }),
    sample({
        id: 100011, title: "QA Automation Engineer", company: "Fabrikam Robotics", location: "Chennai",
        jobType: "full-time", workType: "onsite", experience: "1-3 years", salary: "₹6-10 LPA",
        categories: ["engineer"], hoursAgo: 190,
        summary: "Automate regression suites with Selenium and Java. You will plug the tests into CI/CD so every release is checked before it ships.",
    }),
    sample({
        id: 100012, title: "Full Stack Developer (6-month contract)", company: "Lucerne Publishing", location: "Remote",
        jobType: "contract", workType: "remote", experience: "1-2 years", salary: "₹60,000/month",
        categories: ["developer"], hoursAgo: 200,
        summary: "Rebuild the editorial dashboard with React on the front end and Node.js on the back end. Data lives in PostgreSQL, and the contract may be extended.",
    }),
    sample({
        id: 100013, title: "HR Operations Intern", company: "Wide World Importers", location: "Pune",
        jobType: "internship", workType: "onsite", experience: "Freshers", salary: "₹15,000/month stipend",
        categories: ["hr"], hoursAgo: 215,
        summary: "Coordinate interviews and onboarding for new hires. You will maintain HR trackers in Excel, and clear Communication with candidates matters.",
    }),
    sample({
        id: 100014, title: "DevOps Engineer", company: "Alpine Ski House", location: "Hyderabad",
        jobType: "full-time", workType: "hybrid", experience: "2-4 years", salary: "₹14-20 LPA",
        categories: ["engineer"], hoursAgo: 230,
        summary: "Run production on Docker and Kubernetes clusters hosted on AWS. You will manage infrastructure as code with Terraform.",
    }),
    sample({
        id: 100015, title: "Content Writer (Part-time)", company: "Margie's Travel", location: "Remote",
        jobType: "part-time", workType: "remote", experience: "Freshers", salary: "₹15,000/month",
        categories: ["content"], hoursAgo: 238,
        summary: "Write destination guides and blog posts with SEO best practices in mind. Strong Writing skills and a portfolio of published pieces help.",
    }),
    sample({
        id: 100016, title: "Business Analyst", company: "Coho Vineyard", location: "Kolkata",
        jobType: "full-time", workType: "onsite", experience: "0-2 years", salary: "₹6-8 LPA",
        categories: ["consulting", "data-analyst"], hoursAgo: 239,
        summary: "Gather requirements from operations teams and model processes. You will analyse data with SQL and Excel and publish Tableau reports for leadership.",
    }),
].map((job) => Object.freeze(job)));

/**
 * Insert the sample listings (idempotent: dedupe keys). Re-seeding refreshes their
 * posting dates. Never notifies.
 * @returns {Promise<{inserted: number, existing: number}>}
 */
export const seedSampleExternalJobs = async ({ now = new Date() } = {}) => {
    const inputs = SAMPLE_EXTERNAL_JOBS.map(({ hoursAgo, ...job }) => ({
        ...job,
        postedAt: new Date(now.getTime() - hoursAgo * HOUR_MS),
    }));
    const stats = await jobSyncService.ingest(SAMPLE_SOURCE, inputs, now);
    return { inserted: stats.inserted, existing: stats.duplicates };
};

/** Name the demo seed (AUTH-FACULTY.md §16) looks for. */
export const seedSampleJobs = seedSampleExternalJobs;

/**
 * Remove every sample listing and the tracker entries that point at them (demo wipe).
 * @returns {Promise<{deleted: number, savedEntriesDeleted: number}>}
 */
export const removeSampleJobs = async () => {
    const ids = await ExternalJob.find({ isSample: true }).distinct("_id");
    if (!ids.length) return { deleted: 0, savedEntriesDeleted: 0 };
    const saved = await SavedJob.deleteMany({ job: { $in: ids } });
    const jobs = await ExternalJob.deleteMany({ _id: { $in: ids }, isSample: true });
    return { deleted: jobs.deletedCount ?? 0, savedEntriesDeleted: saved.deletedCount ?? 0 };
};
