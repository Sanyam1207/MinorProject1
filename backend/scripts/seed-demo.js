// Demo data seed for Matchy Campus (docs/contracts/AUTH-FACULTY.md §16).
//
//   npm run seed:demo                          # create or top up the demo dataset (idempotent)
//   npm run seed:demo -- --reset               # wipe all demo data, then seed again from scratch
//   npm run seed:demo -- --reset --no-seed     # wipe only
//   --force                                    # required when NODE_ENV=production
//
// Demo data is everything tied to the college with domain demo.edu: users whose
// email ends with @demo.edu or @acme-demo.com (the demo recruiter), or whose
// `college` is the demo college, plus the records that reference them. The wipe
// never touches anything else (shared Company documents are kept).
//
// Passwords: ONE password for every demo account, from DEMO_PASSWORD or
// generated. It is hashed once with bcrypt (10 rounds) and written with
// findOneAndUpdate `$set` on every run (never User.create()/save(), whose
// pre-save hook would hash it a second time). seedDemo() never logs it; the CLI
// prints it once in the final summary for the local developer.
//
// The module also exports parseSeedArgs, resolveDemoPassword, seedDemo and
// wipeDemo so tests can drive it without the CLI.
import crypto from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import mongoose from "mongoose";

import { APP_TIMEZONE, TPO_EMAIL } from "../src/config/config.js";
import DBConnect from "../src/db/db.js";
import { College } from "../src/models/college.models.js";
import { Student } from "../src/models/student.models.js";
import { User } from "../src/models/user.models.js";
import { claimCollegeTpoSlot } from "../src/services/auth-policy.service.js";
import { canonicalBranch, canonicalBranchList } from "../src/utils/branch.js";
import { linkStudentToCollege } from "../src/utils/student-college.js";
import { DEFAULT_SETTINGS, JOIN_CODE_ALPHABET, hashDevice } from "../src/modules/attendance/config.js";
import { generateJoinCode } from "../src/modules/attendance/courses.service.js";
import { AttendanceRecord, ClassSession, Course } from "../src/modules/attendance/models/index.js";
import { materialiseCourse } from "../src/modules/attendance/sessions.service.js";
import { computeNeedToReach, recountSessionStats, summarise } from "../src/modules/attendance/stats.js";
import { ExternalJob } from "../src/modules/job-feed/models/external-job.model.js";
import { removeSampleJobs, seedSampleExternalJobs } from "../src/modules/job-feed/sample-jobs.js";
import { upsertSavedJob } from "../src/modules/job-feed/tracker.service.js";
import { notify } from "../src/modules/notifications/notify.js";
import { DEFAULT_POLICY } from "../src/modules/placements/constants.js";
import { academicYearFor } from "../src/modules/placements/services/academic-year.js";
import { findOrCreateCompany } from "../src/modules/placements/services/drive.service.js";
import { evaluateForJob, studentFacts } from "../src/modules/placements/services/eligibility.service.js";
import { purgeResumesForUsers } from "../src/modules/resume-lab/services/resume.service.js";

// ── Constants and fixtures ──────────────────────────────────────────────────

const DOMAIN = "demo.edu";
const RECRUITER_DOMAIN = "acme-demo.com";
const DEMO_EMAIL_RE = /@(demo\.edu|acme-demo\.com)$/i;
// Optional: DEMO_OWNER_EMAIL=you@gmail.com gives the demo TPO your address and the demo teacher
// (Anita), student (Diya) and recruiter your "+teacher", "+student", "+recruiter" aliases, so
// you can sign in to every role with your own inbox. They belong to the demo college, so
// --reset wipes them with the rest of the demo data.
const OWNER_EMAIL = String(process.env.DEMO_OWNER_EMAIL || "").trim().toLowerCase();
const ownerAlias = (tag) => {
    const [local, domain] = OWNER_EMAIL.split("@");
    return `${local}+${tag}@${domain}`;
};
if (OWNER_EMAIL && !/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(OWNER_EMAIL)) {
    throw new Error("DEMO_OWNER_EMAIL must be a plain address like you@gmail.com (no '+').");
}
const COLLEGE_NAME = "Demo Institute of Technology";
const BRANCHES = ["CSE", "IT", "ECE"];
const DEPARTMENTS = ["CSE", "IT", "ECE", "Training & Placement"];
const PASSING_YEAR = "2027";
const SEMESTER = 7;
const ACADEMIC_YEAR = "2026-27";
const TZ = APP_TIMEZONE || "Asia/Kolkata";
const PAST_WINDOW_DAYS = 28;
const UPCOMING_DAYS = 7;
const LIVE_DEMO_TOPIC = "Live demo class";
const SELECTION_PROCESS = "Online test → Technical interview → HR";
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const M = (name) => mongoose.models[name] || null;

const TPO_FIXTURE = {
    name: "Dr. Kavita Rao",
    designation: "Training & Placement Officer",
    department: "Training & Placement",
};

const TEACHERS = [
    { key: "anita", email: OWNER_EMAIL ? ownerAlias("teacher") : "anita.sharma@demo.edu", name: "Dr. Anita Sharma", department: "CSE", designation: "Associate Professor", employeeId: "DIT-F-104" },
    { key: "rahul", email: "rahul.verma@demo.edu", name: "Prof. Rahul Verma", department: "IT", designation: "Assistant Professor", employeeId: "DIT-F-117" },
];

const ALUMNI = [
    {
        email: "nisha.kapoor@demo.edu", name: "Nisha Kapoor", company: "Microsoft", currentRole: "SDE II", graduationYear: 2022, branch: "CSE",
        location: "Hyderabad", skills: ["C++", "System Design", "Azure", "Data Structures"],
        mentoringTopics: ["Big-tech interviews", "System design basics", "Resume review"],
        requestTypes: ["career-guidance", "resume-review", "mock-interview", "company-insights"], availability: "Saturday 11:00–13:00",
    },
    {
        email: "rohan.mehra@demo.edu", name: "Rohan Mehra", company: "Razorpay", currentRole: "Backend Engineer", graduationYear: 2023, branch: "IT",
        location: "Bengaluru", skills: ["Go", "Node.js", "PostgreSQL", "Distributed Systems"],
        mentoringTopics: ["Backend engineering", "Fintech careers", "Project review"],
        requestTypes: ["career-guidance", "project-review", "mock-interview", "company-insights"], availability: "Wednesday 19:00–20:00",
    },
];

const RECRUITER = { email: OWNER_EMAIL ? ownerAlias("recruiter") : "hr@acme-demo.com", name: "Sameer Khanna", designation: "Campus Hiring Manager", companyName: "Acme Technologies" };

const PERSONAS = {
    W: { skills: ["JavaScript", "React", "Node.js", "MongoDB", "REST APIs"], project: "Event booking web app",
        description: "A full-stack app where students browse college events, book seats and get QR tickets.", roles: ["Full Stack Developer", "Frontend Developer"] },
    D: { skills: ["Python", "SQL", "Pandas", "Power BI", "Statistics"], project: "Sales analytics dashboard",
        description: "Cleaned two years of retail sales data with Pandas and built a Power BI dashboard of regional trends.", roles: ["Data Analyst", "Business Analyst"] },
    M: { skills: ["Python", "scikit-learn", "PyTorch", "NLP", "Data Structures"], project: "Resume screening with NLP",
        description: "Ranks resumes against a job description using TF-IDF baselines and a fine-tuned transformer.", roles: ["Machine Learning Engineer", "Software Engineer"] },
    C: { skills: ["Linux", "Docker", "AWS", "Kubernetes", "CI/CD"], project: "CI/CD pipeline for a microservice",
        description: "GitHub Actions pipeline that tests, containerises and deploys a Node.js service to a Kubernetes cluster.", roles: ["DevOps Engineer", "Cloud Engineer"] },
    J: { skills: ["Java", "Data Structures", "Algorithms", "OOP", "DBMS"], project: "Library management system",
        description: "Java and MySQL desktop application for issuing, returning and reserving books with fine calculation.", roles: ["Software Engineer", "Java Developer"] },
    S: { skills: ["Networking", "Linux", "Python", "Cryptography", "Wireshark"], project: "Network intrusion detection lab",
        description: "Captured lab traffic with Wireshark and flagged port scans and brute-force attempts with Python rules.", roles: ["Security Analyst", "Network Engineer"] },
};

// [first, last, cgpa, attendance target, persona] per branch-section (§16.2).
const SECTIONS = [
    { branch: "CSE", section: "A", students: [
        ["Aarav", "Gupta", 9.12, 0.94, "M"], ["Diya", "Mehta", 8.65, 0.88, "W"], ["Kabir", "Singh", 6.40, 0.62, "J"],
        ["Ananya", "Iyer", 8.90, 0.91, "D"], ["Vihaan", "Reddy", 7.35, 0.80, "C"], ["Ishita", "Bansal", 8.10, 0.86, "W"],
        ["Arjun", "Nair", 7.05, 0.71, "J"], ["Meera", "Joshi", 9.40, 0.97, "M"],
    ] },
    { branch: "CSE", section: "B", students: [
        ["Rohan", "Malhotra", 7.80, 0.84, "C"], ["Sneha", "Kulkarni", 8.45, 0.90, "D"], ["Aditya", "Rao", 6.90, 0.66, "W"],
        ["Kavya", "Menon", 9.05, 0.93, "J"], ["Siddharth", "Jain", 7.60, 0.78, "C"], ["Pooja", "Yadav", 8.20, 0.87, "M"],
        ["Nikhil", "Chauhan", 6.75, 0.74, "S"],
    ] },
    { branch: "IT", section: "A", students: [
        ["Riya", "Kapoor", 7.80, 0.72, "W"], ["Yash", "Agarwal", 8.35, 0.89, "W"], ["Tanvi", "Deshpande", 8.75, 0.92, "D"],
        ["Harsh", "Vardhan", 7.15, 0.79, "C"], ["Neha", "Pillai", 8.95, 0.95, "M"], ["Aryan", "Sethi", 6.55, 0.64, "J"],
        ["Simran", "Gill", 7.90, 0.85, "S"], ["Varun", "Bhatia", 7.45, 0.81, "W"],
    ] },
    { branch: "IT", section: "B", students: [
        ["Aditi", "Saxena", 8.60, 0.90, "S"], ["Karan", "Thakur", 6.85, 0.68, "C"], ["Shreya", "Ghosh", 9.20, 0.96, "D"],
        ["Manav", "Arora", 7.70, 0.83, "J"], ["Anjali", "Verma", 8.05, 0.87, "W"], ["Dev", "Patel", 7.25, 0.77, "S"],
        ["Zoya", "Khan", 8.80, 0.92, "M"],
    ] },
];

const BACKLOGS = { kabir: 1, aryan: 1, karan: 2 };

const COURSES = [
    {
        code: "CS701", name: "Machine Learning", teacher: "anita", branch: "CSE", section: "A", room: "LT-1",
        slots: [[1, "10:00"], [3, "10:00"], [5, "11:00"]],
        topics: ["Introduction to machine learning", "Linear regression and gradient descent", "Logistic regression",
            "Bias–variance trade-off and regularisation", "Decision trees and random forests", "Support vector machines",
            "k-means and hierarchical clustering", "Principal component analysis", "Neural network basics",
            "Model evaluation and cross-validation", "Feature engineering", "Boosting and ensembles"],
    },
    {
        code: "CS703", name: "Cloud Computing", teacher: "anita", branch: "CSE", section: "B", room: "LT-2",
        slots: [[2, "11:00"], [4, "11:00"]],
        topics: ["Cloud service models: IaaS, PaaS, SaaS", "Virtualisation and hypervisors", "Containers with Docker",
            "Kubernetes fundamentals", "Cloud storage and managed databases", "Serverless computing",
            "Cloud networking and VPCs", "Identity and access management", "Autoscaling and load balancing", "Cost optimisation"],
    },
    {
        code: "IT701", name: "Web Engineering", teacher: "rahul", branch: "IT", section: "A", room: "Lab-3",
        slots: [[1, "14:00"], [3, "14:00"]],
        topics: ["HTTP and web architecture", "Semantic HTML and accessibility", "Modern CSS layouts", "JavaScript and the DOM",
            "Asynchronous JavaScript", "React components and state", "REST API design with Express", "Authentication with JWT",
            "MongoDB data modelling", "Testing web applications", "Deployment and CI/CD"],
    },
    {
        code: "IT705", name: "Information Security", teacher: "rahul", branch: "IT", section: "B", room: "LT-4",
        slots: [[2, "15:00"], [5, "15:00"]],
        topics: ["Security goals and threat models", "Symmetric cryptography", "Public-key cryptography and RSA",
            "Hash functions and MACs", "PKI and TLS", "Authentication protocols", "Web security: OWASP Top 10",
            "Network attacks and firewalls", "Intrusion detection systems", "Incident response"],
    },
];

// deadline / drive date are days from now (§16.4); the Acme drive is the recruiter's, pending approval.
const DRIVES = [
    {
        key: "msft-swe", company: "Microsoft", title: "Software Engineer (New Grad)", ctc: 44, location: "Hyderabad", minCgpa: 8.0, maxBacklogs: 0,
        branches: ["CSE", "IT"], skills: ["Data Structures", "Algorithms", "System Design", "C++"], deadline: -10, drive: -5, status: "closed", published: -30,
        min10: 75, min12: 75,
        description: "Microsoft India Development Center is hiring new-grad Software Engineers for Azure and Microsoft 365 teams. You will design, build and ship features used by millions, write high-quality C++ or C# code, and own services end to end with your team.",
    },
    {
        key: "razorpay-be", company: "Razorpay", title: "Backend Engineer", ctc: 24, location: "Bengaluru", minCgpa: 7.5, maxBacklogs: 0,
        branches: ["CSE", "IT"], skills: ["Node.js", "Go", "SQL", "Distributed Systems"], deadline: -2, drive: -1, status: "closed", published: -14,
        description: "Razorpay's payments platform team is looking for Backend Engineers to build reliable, low-latency APIs that move money for millions of businesses. You will work on Go and Node.js services, design SQL schemas and help keep the platform highly available.",
    },
    {
        key: "infosys-sp", company: "Infosys", title: "Specialist Programmer", ctc: 9.5, location: "Pune", minCgpa: 6.5, maxBacklogs: 1,
        branches: ["CSE", "IT"], skills: ["Java", "Python", "SQL", "Problem Solving"], deadline: 10, drive: 14, status: "active", published: -6,
        min10: 60, min12: 60,
        description: "Infosys is hiring Specialist Programmers for its digital engineering practice. Selected candidates join an intensive training program and then work on full-stack and cloud projects for global clients, with a fast track to senior engineering roles.",
    },
    {
        key: "zomato-da", company: "Zomato", title: "Data Analyst", ctc: 14, location: "Gurugram", minCgpa: 7.0, maxBacklogs: 0,
        branches: ["CSE", "IT"], skills: ["SQL", "Python", "Excel", "Statistics"], deadline: 3, drive: 6, status: "active", published: -8,
        description: "Zomato's analytics team turns order, delivery and restaurant data into decisions. As a Data Analyst you will write SQL and Python, build dashboards for city teams and run experiments that improve delivery times and customer experience.",
    },
    {
        key: "deloitte-cyber", company: "Deloitte", title: "Cyber Security Analyst", ctc: 8, location: "Hyderabad", minCgpa: 6.5, maxBacklogs: 1,
        branches: ["IT", "CSE"], skills: ["Networking", "Linux", "SIEM", "Python"], deadline: 14, drive: 20, status: "active", published: -3,
        min10: 60, min12: 60,
        description: "Deloitte's Cyber Risk practice is hiring analysts for its security operations centre. You will monitor SIEM alerts, investigate incidents, harden Linux and network configurations and help clients respond to threats.",
    },
    {
        key: "atlassian-gse", company: "Atlassian", title: "Graduate Software Engineer", ctc: 52, location: "Bengaluru", minCgpa: 8.5, maxBacklogs: 0,
        branches: ["CSE"], skills: ["Java", "Data Structures", "System Design"], deadline: 7, drive: 12, status: "active", published: -1,
        min10: 80, min12: 80,
        description: "Atlassian is hiring Graduate Software Engineers to build Jira and Confluence. You will write Java and TypeScript, design scalable services on AWS and collaborate with distributed teams in a culture built on open company values.",
    },
    {
        key: "tcs-digital", company: "TCS", title: "Digital Engineer", ctc: 7.5, location: "Pan India", minCgpa: 6.0, maxBacklogs: 2,
        branches: ["CSE", "IT"], skills: ["Java", "SQL", "Cloud Basics"], deadline: 20, drive: 25, status: "draft", published: null,
        description: "TCS Digital hires engineers for cloud, data and enterprise application projects. After onboarding you will work with modern Java and cloud platforms on large digital transformation programs.",
    },
    {
        key: "acme-ase", company: RECRUITER.companyName, title: "Associate Software Engineer", ctc: 6.5, location: "Noida", minCgpa: 6.5, maxBacklogs: 1,
        branches: ["CSE", "IT"], skills: ["JavaScript", "Node.js", "SQL", "Git"], deadline: 12, drive: 16, status: "pending", published: null, byRecruiter: true,
        description: "Acme Technologies builds SaaS tools for logistics companies. Associate Software Engineers join a product squad, ship Node.js and React features, write SQL and learn modern engineering practices with mentoring from senior engineers.",
    },
];

// [drive key, student key, status] (§16.4: 21 applications).
const APPLICATIONS = [
    ["msft-swe", "aarav", "hired"], ["msft-swe", "meera", "rejected"], ["msft-swe", "kavya", "rejected"],
    ["msft-swe", "shreya", "rejected"], ["msft-swe", "neha", "rejected"],
    ["razorpay-be", "diya", "offered"], ["razorpay-be", "ishita", "rejected"], ["razorpay-be", "yash", "rejected"], ["razorpay-be", "anjali", "withdrawn"],
    ["infosys-sp", "kabir", "applied"], ["infosys-sp", "vihaan", "applied"], ["infosys-sp", "manav", "applied"], ["infosys-sp", "dev", "applied"],
    ["infosys-sp", "aryan", "applied"], ["infosys-sp", "rohan", "shortlisted"],
    ["zomato-da", "ananya", "shortlisted"], ["zomato-da", "sneha", "interview"], ["zomato-da", "tanvi", "applied"],
    ["deloitte-cyber", "aditi", "shortlisted"], ["deloitte-cyber", "simran", "applied"],
    ["atlassian-gse", "kavya", "applied"],
];

const TRAINING = [
    {
        title: "Aptitude & Reasoning Bootcamp", type: "aptitude", deliveryMode: "online", instructor: "Placement Cell", capacity: 60,
        description: "Four evening sessions on quantitative aptitude, logical reasoning and verbal ability, with a timed mock test at the end of each session.",
        audience: { branches: [], graduationYears: [PASSING_YEAR], minCgpa: null },
        students: ["kabir", "vihaan", "arjun", "aditya", "siddharth", "nikhil", "riya", "harsh", "aryan", "varun", "karan", "manav", "dev", "anjali"],
    },
    {
        title: "DSA Interview Sprint", type: "technical", deliveryMode: "offline", instructor: "Dr. Anita Sharma", capacity: 40,
        description: "Six hands-on sessions on arrays, trees, graphs and dynamic programming, solving interview problems on the whiteboard and in code.",
        audience: { branches: ["CSE", "IT"], graduationYears: [PASSING_YEAR], minCgpa: null },
        students: ["diya", "ananya", "ishita", "meera", "kavya", "pooja", "rohan", "yash", "tanvi", "neha", "shreya", "zoya"],
    },
    {
        title: "Mock Interview Week", type: "mock-interview", deliveryMode: "hybrid", instructor: "Alumni mentors", capacity: 30,
        description: "One-on-one technical and HR mock interviews with alumni from Microsoft, Razorpay and other recruiters, with written feedback.",
        audience: { branches: [], graduationYears: [PASSING_YEAR], minCgpa: 7.0 },
        students: ["sneha", "ananya", "tanvi", "aditi", "simran", "manav", "rohan", "vihaan"],
    },
];

const SAVED_JOBS = [
    ["ananya", "Data Analyst Intern", "applied", "Applied through the careers page; online test expected next week."],
    ["yash", "Frontend Developer", "saved", "Good fit for my React project."],
    ["neha", "Machine Learning Engineer", "interviewing", "First technical round done."],
    ["varun", "Backend Developer (Node.js)", "saved", ""],
];

const ISSUE_REPORTS = [
    { student: "vihaan", description: "QR scanner asks for camera permission twice on iOS Safari", page: "attendance.scan", status: "open" },
    { student: "pooja", description: "Resume PDF preview is blank after compiling", page: "resume.lab", status: "in_progress", note: "Reproduced, fixing" },
];

// ── Small helpers ───────────────────────────────────────────────────────────

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest();
const hash32 = (text) => sha(text).readUInt32BE(0);
/** Deterministic number in [0, 1) for a string. */
const unit = (text) => hash32(text) / 2 ** 32;

const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const seededShuffle = (items, seed) => {
    const out = [...items];
    const random = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const local = (date) => DateTime.fromJSDate(date instanceof Date ? date : new Date(date), { zone: TZ });
const minutesFrom = (date, minutes) => new Date(new Date(date).getTime() + minutes * 60_000);
const daysFrom = (now, days) => new Date(now.getTime() + days * 86_400_000);
const dayStart = (now, offset) => local(now).startOf("day").plus({ days: offset }).toJSDate();
const dayEnd = (now, offset) => local(now).startOf("day").plus({ days: offset }).endOf("day").toJSDate();
const dayAt = (now, offset, hhmm) => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return local(now).startOf("day").plus({ days: offset }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
};
const ceilTo15 = (date) => {
    const value = local(date).startOf("minute");
    const extra = (15 - (value.minute % 15)) % 15;
    const bumped = value.plus({ minutes: extra });
    return (bumped.toMillis() < date.getTime() ? bumped.plus({ minutes: 15 }) : bumped).toJSDate();
};
const describeTime = (date, now) => {
    const value = local(date);
    const day = value.hasSame(local(now), "day") ? "today" : value.toFormat("ccc d LLL");
    return `${day} ${value.toFormat("HH:mm")}`;
};
const round1 = (value) => Math.round(value * 10) / 10;
const pad = (value, width) => String(value).padEnd(width);
const emailOf = (first, last) => `${first}.${last}@${DOMAIN}`.toLowerCase();
const keyOf = (first) => first.toLowerCase();
const isDuplicate = (error) => error?.code === 11000;
const idStr = (value) => String(value?._id ?? value);

/** Deterministic join code from the course code (6 chars of [A-HJ-NP-Z2-9]). */
const joinCodeFor = (code) => {
    const bytes = sha(`demo-join:${code}`);
    let out = "";
    for (let i = 0; i < 6; i += 1) out += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
    return out;
};

const tenthAndTwelfth = (key, cgpa) => {
    const base = 62 + (cgpa - 6) * 8.5;
    const tenth = Math.min(97.4, round1(base + unit(`10th:${key}`) * 8));
    const twelfth = Math.min(96.8, round1(base - 2 + unit(`12th:${key}`) * 9));
    return { tenthPercentage: tenth, twelfthPercentage: twelfth };
};

// ── CLI helpers ─────────────────────────────────────────────────────────────

/** `--reset`, `--no-seed`, `--force` → {reset, seed, force}. Unknown flags throw. */
export const parseSeedArgs = (argv = []) => {
    const args = { reset: false, seed: true, force: false };
    for (const raw of argv) {
        const flag = String(raw).trim();
        if (flag === "--reset") args.reset = true;
        else if (flag === "--no-seed") args.seed = false;
        else if (flag === "--force") args.force = true;
        else throw new Error(`Unknown option "${flag}". Use --reset, --no-seed or --force.`);
    }
    if (!args.seed && !args.reset) throw new Error("--no-seed only makes sense together with --reset");
    return args;
};

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const DIGITS = "23456789";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The demo password: DEMO_PASSWORD (8–128 chars) or a generated "Demo-xxxxxxxxxx" with letters and digits. */
export const resolveDemoPassword = (env = process.env) => {
    const given = env?.DEMO_PASSWORD;
    if (given !== undefined && given !== null && String(given) !== "") {
        const value = String(given);
        if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
            throw new Error(`DEMO_PASSWORD must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters long (the app rejects shorter passwords at sign-in).`);
        }
        return value;
    }
    const chars = Array.from({ length: 10 }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]);
    if (!chars.some((char) => DIGITS.includes(char))) chars[crypto.randomInt(chars.length)] = DIGITS[crypto.randomInt(DIGITS.length)];
    if (!chars.some((char) => LETTERS.includes(char))) chars[0] = LETTERS[crypto.randomInt(LETTERS.length)];
    if (!chars.some((char) => DIGITS.includes(char))) chars[9] = DIGITS[crypto.randomInt(DIGITS.length)];
    return `Demo-${chars.join("")}`;
};

/** Refuse to run against production unless --force. Returns an error message or null. */
export const productionGuard = (args, env = process.env) => (
    String(env.NODE_ENV || "").trim().toLowerCase() === "production" && !args.force
        ? "Refusing to touch a production database (NODE_ENV=production). Re-run with --force if you really mean it."
        : null
);

// ── Users ───────────────────────────────────────────────────────────────────

/**
 * Upsert a demo user. The pre-hashed password goes through `$set`, so the
 * pre-save hook never runs (no double hashing) and the printed password always works.
 */
const upsertUser = async ({ email, role, college, passwordHash, set = {}, onInsert = {} }) => User.findOneAndUpdate(
    { email },
    {
        $set: {
            password: passwordHash,
            isActive: true,
            mustChangePassword: false,
            role,
            college: college._id,
            collegeName: college.name,
            authProvider: "local",
            ...set,
        },
        $setOnInsert: onInsert,
        $unset: { tempPasswordExpiresAt: "", deactivatedAt: "", deactivatedBy: "" },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true },
);

const buildStudentFixtures = () => {
    const out = [];
    for (const group of SECTIONS) {
        group.students.forEach(([first, last, cgpa, rate, persona], index) => {
            const key = keyOf(first);
            out.push({
                key,
                first,
                last,
                name: `${first} ${last}`,
                email: OWNER_EMAIL && key === "diya" ? ownerAlias("student") : emailOf(first, last),
                branch: canonicalBranch(group.branch),
                section: group.section,
                rollNumber: `DIT27${group.branch}${group.section}${String(index + 1).padStart(2, "0")}`,
                cgpa,
                rate,
                persona,
                activeBacklogs: BACKLOGS[key] ?? 0,
                ...tenthAndTwelfth(key, cgpa),
            });
        });
    }
    return out;
};

const seedIdentity = async ({ passwordHash, log, warnings }) => {
    const tpoEmail = OWNER_EMAIL || (TPO_EMAIL && TPO_EMAIL.endsWith(`@${DOMAIN}`) ? TPO_EMAIL : `tpo@${DOMAIN}`);
    const notes = [];
    if (!OWNER_EMAIL && tpoEmail !== TPO_EMAIL) notes.push(`TPO_EMAIL is not a @${DOMAIN} address; the demo TPO is ${tpoEmail}.`);

    const college = await College.findOneAndUpdate(
        { domain: DOMAIN },
        { $set: { name: COLLEGE_NAME, branches: canonicalBranchList(BRANCHES), departments: canonicalBranchList(DEPARTMENTS) } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

    const tpo = await upsertUser({
        email: tpoEmail, role: "tpo", college, passwordHash,
        set: { designation: TPO_FIXTURE.designation, department: TPO_FIXTURE.department },
        onInsert: { name: TPO_FIXTURE.name },
    });
    try {
        await claimCollegeTpoSlot(college, tpo._id);
    } catch (error) {
        if (error?.statusCode !== 409) throw error;
        // The demo college's slot is held by another (demo) account: hand it to the demo TPO.
        await College.updateOne({ _id: college._id }, { $set: { tpo: tpo._id } });
        warnings.push("The demo college's TPO slot was held by another account; it now points to the demo TPO.");
    }

    const teachers = {};
    for (const fixture of TEACHERS) {
        teachers[fixture.key] = await upsertUser({
            email: fixture.email, role: "teacher", college, passwordHash,
            onInsert: {
                name: fixture.name,
                department: canonicalBranch(fixture.department),
                designation: fixture.designation,
                employeeId: fixture.employeeId,
                invitedBy: tpo._id,
                invitedAt: new Date(),
            },
        });
    }

    const alumni = [];
    for (const fixture of ALUMNI) {
        const user = await upsertUser({
            email: fixture.email, role: "alumni", college, passwordHash,
            onInsert: { name: fixture.name, branch: canonicalBranch(fixture.branch), passingYear: String(fixture.graduationYear) },
        });
        alumni.push({ user, fixture });
    }

    const company = await findOrCreateCompany(RECRUITER.companyName);
    const recruiter = await upsertUser({
        email: RECRUITER.email, role: "company", college, passwordHash,
        set: { company: company._id },
        onInsert: { name: RECRUITER.name, designation: RECRUITER.designation, invitedBy: tpo._id, invitedAt: new Date() },
    });

    const students = {};
    for (const fixture of buildStudentFixtures()) {
        const persona = PERSONAS[fixture.persona];
        const user = await upsertUser({
            email: fixture.email, role: "student", college, passwordHash,
            onInsert: {
                name: fixture.name,
                branch: fixture.branch,
                section: fixture.section,
                semester: SEMESTER,
                passingYear: PASSING_YEAR,
                rollNumber: fixture.rollNumber,
                cgpa: fixture.cgpa,
                activeBacklogs: fixture.activeBacklogs,
                tenthPercentage: fixture.tenthPercentage,
                twelfthPercentage: fixture.twelfthPercentage,
                ggsipuLinked: false,
                skills: persona.skills,
                projects: [{ title: persona.project, description: persona.description, skills: persona.skills.slice(0, 3) }],
                careerPreferences: { preferredRoles: persona.roles, preferredLocations: ["Bengaluru", "Hyderabad", "Pune"], expectedSalary: "" },
                socialLinks: { github: "", linkedin: "", leetcode: "", portfolio: "" },
            },
        });
        // Same linking as sign-up/login (auth.controller.js createRegisteredUser / afterLogin).
        await linkStudentToCollege(user, college);
        await Student.updateOne(
            { _id: user.student },
            { $set: { university: COLLEGE_NAME, semester: SEMESTER, overallCGPA: fixture.cgpa, skills: persona.skills } },
        );
        students[fixture.key] = { user, fixture };
    }

    const AlumniProfile = M("AlumniProfile");
    if (!AlumniProfile) warnings.push("skip: AlumniProfile not registered");
    else {
        for (const { user, fixture } of alumni) {
            await AlumniProfile.updateOne(
                { user: user._id },
                {
                    $setOnInsert: {
                        college: college._id,
                        name: fixture.name,
                        branch: canonicalBranch(fixture.branch),
                        degree: "B.Tech",
                        graduationYear: fixture.graduationYear,
                        company: fixture.company,
                        currentRole: fixture.currentRole,
                        location: fixture.location,
                        bio: `${fixture.name} (${COLLEGE_NAME}, ${fixture.graduationYear}) works as ${fixture.currentRole} at ${fixture.company} and mentors juniors on interviews and projects.`,
                        skills: fixture.skills,
                        mentoringTopics: fixture.mentoringTopics,
                        languages: ["English", "Hindi"],
                        requestTypes: fixture.requestTypes,
                        availability: fixture.availability,
                    },
                    $set: { capacity: 3, acceptingRequests: true, onboardingComplete: true, isDemo: true },
                },
                { upsert: true, setDefaultsOnInsert: true },
            );
        }
    }

    const freshCollege = await College.findById(college._id);
    log(`[seed] identity: college ${DOMAIN}, 1 TPO, ${TEACHERS.length} teachers, ${ALUMNI.length} alumni, 1 recruiter, ${Object.keys(students).length} students`);
    return { college: freshCollege, tpo, teachers, alumni, recruiter, company, students, notes };
};

// ── Attendance ──────────────────────────────────────────────────────────────

const upsertCourse = async (fixture, { teacher, studentIds }) => {
    const key = { teacher: teacher._id, code: fixture.code, section: fixture.section, academicYear: ACADEMIC_YEAR };
    const onInsert = {
        name: fixture.name,
        department: canonicalBranch(teacher.department || fixture.branch),
        branch: canonicalBranch(fixture.branch),
        semester: SEMESTER,
        passingYear: PASSING_YEAR,
        room: fixture.room,
        timetable: fixture.slots.map(([day, start]) => ({ day, start, durationMinutes: 60, room: fixture.room })),
        settings: { ...DEFAULT_SETTINGS },
        status: "active",
    };
    const write = (joinCode) => Course.findOneAndUpdate(
        key,
        { $setOnInsert: { ...onInsert, joinCode }, $addToSet: { students: { $each: studentIds } } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();
    try {
        return await write(joinCodeFor(fixture.code));
    } catch (error) {
        if (!isDuplicate(error) || !Object.keys(error.keyPattern || error.keyValue || {}).includes("joinCode")) throw error;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                return await write(generateJoinCode());
            } catch (retryError) {
                if (!isDuplicate(retryError)) throw retryError;
            }
        }
        throw new Error(`Could not allocate a join code for ${fixture.code}`);
    }
};

const endedFields = (startsAt, endsAt, seedText) => ({
    status: "ended",
    liveStartedAt: minutesFrom(startsAt, 1),
    endedAt: endsAt,
    qr: {
        version: 1 + (hash32(`qr-version:${seedText}`) % 40),
        nonce: crypto.randomBytes(16).toString("base64url"),
        issuedAt: new Date(endsAt.getTime() - DEFAULT_SETTINGS.qrRotationSeconds * 1000),
        expiresAt: endsAt,
        rotationSeconds: DEFAULT_SETTINGS.qrRotationSeconds,
    },
});

/** Ended timetable sessions for the last 28 days + any past demo session still `scheduled`. */
const seedPastSessions = async (course, fixture, now) => {
    const first = local(now).startOf("day").minus({ days: PAST_WINDOW_DAYS });
    const slots = [];
    for (let offset = 0; offset <= PAST_WINDOW_DAYS; offset += 1) {
        const day = first.plus({ days: offset });
        const weekday = day.weekday % 7;
        for (const slot of course.timetable) {
            if (slot.day !== weekday) continue;
            const [hour, minute] = slot.start.split(":").map(Number);
            const start = day.set({ hour, minute, second: 0, millisecond: 0 });
            const startsAt = start.toJSDate();
            const endsAt = start.plus({ minutes: slot.durationMinutes || 60 }).toJSDate();
            if (endsAt > now) continue;
            slots.push({ startsAt, endsAt, room: slot.room || course.room });
        }
    }
    slots.sort((a, b) => a.startsAt - b.startsAt);
    let created = 0;
    let converted = 0;
    for (const [index, slot] of slots.entries()) {
        const existing = await ClassSession.findOne({ course: course._id, $or: [{ startsAt: slot.startsAt }, { slotStartsAt: slot.startsAt }] })
            .select("status endsAt").lean();
        if (existing) continue; // the stale-scheduled sweep below handles a still-scheduled one
        try {
            await ClassSession.create({
                course: course._id,
                teacher: course.teacher,
                topic: fixture.topics[index % fixture.topics.length],
                room: slot.room,
                mode: "offline",
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                slotStartsAt: slot.startsAt,
                source: "timetable",
                ...endedFields(slot.startsAt, slot.endsAt, `${course._id}:${slot.startsAt.toISOString()}`),
                stats: { present: 0, late: 0, absent: 0, excused: 0, enrolled: course.students.length },
            });
            created += 1;
        } catch (error) {
            if (!isDuplicate(error)) throw error;
        }
    }
    // Sessions that were scheduled (timetable or the live demo class) and are now over: mark them held.
    const stale = await ClassSession.find({ course: course._id, status: "scheduled", endsAt: { $lte: now } }).lean();
    for (const session of stale) {
        const topicIndex = slots.findIndex((slot) => slot.startsAt.getTime() === session.startsAt.getTime());
        const set = endedFields(session.startsAt, session.endsAt, `${course._id}:${session.startsAt.toISOString()}`);
        if (!session.topic) set.topic = fixture.topics[Math.max(0, topicIndex) % fixture.topics.length];
        const result = await ClassSession.updateOne({ _id: session._id, status: "scheduled" }, { $set: set });
        converted += result.modifiedCount;
    }
    return { created, converted };
};

/** Deterministic records for every ended session (§16.3 steps 1–5), then stats recount (step 6). */
const seedRecords = async (course, fixture, teacher, studentsById, now) => {
    const ended = await ClassSession.find({ course: course._id, status: "ended" }).sort({ startsAt: 1 }).lean();
    const lateAfter = course.settings?.lateAfterMinutes ?? DEFAULT_SETTINGS.lateAfterMinutes;
    const existing = await AttendanceRecord.find({ course: course._id, session: { $in: ended.map((s) => s._id) } })
        .select("session student status").lean();
    const byStudent = new Map();
    for (const record of existing) {
        const id = String(record.student);
        if (!byStudent.has(id)) byStudent.set(id, []);
        byStudent.get(id).push(record);
    }
    const ops = [];
    for (const studentId of course.students.map(String)) {
        const entry = studentsById.get(studentId);
        if (!entry) continue; // a non-demo student who joined: left alone
        const { fixture: student } = entry;
        const held = ended.length;
        let target = Math.round(student.rate * held);
        // Keep a sub-75% persona below the threshold even when rounding would lift it to 75%.
        if (student.rate < 0.75 && held > 0 && target / held >= 0.75) target -= 1;
        const own = byStudent.get(studentId) || [];
        const attended = own.filter((record) => record.status === "present" || record.status === "late").length;
        const marked = new Set(own.map((record) => String(record.session)));
        const missing = ended.filter((session) => !marked.has(String(session._id)));
        const count = Math.max(0, Math.min(missing.length, target - attended));
        const shuffled = seededShuffle(missing, hash32(`${fixture.code}${student.email}`));
        shuffled.forEach((session, index) => {
            const pairKey = `${session._id}:${studentId}`;
            let doc;
            if (index < count) {
                const late = unit(`late:${pairKey}`) < 0.12;
                const markedAt = late
                    ? minutesFrom(session.startsAt, lateAfter + 1 + Math.floor(unit(`late-min:${pairKey}`) * 15))
                    : minutesFrom(session.startsAt, Math.floor(unit(`present-min:${pairKey}`) * 9));
                const viaQr = unit(`method:${pairKey}`) < 0.85;
                doc = {
                    course: course._id,
                    status: late ? "late" : "present",
                    method: viaQr ? "qr" : "manual",
                    markedAt,
                    flags: [],
                    ...(viaQr
                        ? { deviceHash: hashDevice(`demo-device:${studentId}`), qrVersion: session.qr?.version ?? 1 }
                        : { markedBy: teacher._id }),
                };
            } else if (unit(`excused:${pairKey}`) < 0.1 && student.rate >= 0.8) {
                doc = { course: course._id, status: "excused", method: "manual", markedBy: teacher._id, markedAt: session.endedAt || session.endsAt, note: "Medical leave", flags: [] };
            } else {
                doc = { course: course._id, status: "absent", method: "auto", markedAt: session.endedAt || session.endsAt, flags: [] };
            }
            ops.push({
                updateOne: {
                    filter: { session: session._id, student: new mongoose.Types.ObjectId(studentId) },
                    update: { $setOnInsert: doc },
                    upsert: true,
                },
            });
        });
    }
    if (ops.length) await AttendanceRecord.bulkWrite(ops, { ordered: false });
    // Denormalised session stats from the records (the module's own recount).
    for (const session of ended) {
        const stats = await recountSessionStats(session._id, course.students.length);
        await ClassSession.updateOne({ _id: session._id }, { $set: { stats } });
    }
    return { inserted: ops.length, ended: ended.length };
};

/** One "Live demo class" per teacher, starting at the next quarter hour after now + 10 min. */
const seedLiveDemoClass = async (course, now) => {
    const startsAt = ceilTo15(minutesFrom(now, 10));
    const endsAt = minutesFrom(startsAt, 60);
    const atTarget = await ClassSession.findOne({ course: course._id, startsAt, status: { $in: ["scheduled", "live", "ended"] } }).lean();
    const previous = await ClassSession.findOne({ course: course._id, topic: LIVE_DEMO_TOPIC, status: "scheduled", endsAt: { $gt: now } }).lean();
    if (atTarget) {
        if (atTarget.status === "scheduled" && atTarget.topic !== LIVE_DEMO_TOPIC) {
            await ClassSession.updateOne({ _id: atTarget._id }, { $set: { topic: LIVE_DEMO_TOPIC } });
        }
        if (previous && String(previous._id) !== String(atTarget._id)) {
            if (previous.source === "manual") await ClassSession.deleteOne({ _id: previous._id, status: "scheduled" });
            else await ClassSession.updateOne({ _id: previous._id }, { $set: { topic: "" } });
        }
        return atTarget.status === "scheduled" ? startsAt : null;
    }
    if (previous) {
        if (previous.source === "manual") {
            await ClassSession.updateOne({ _id: previous._id }, { $set: { startsAt, endsAt } });
            return startsAt;
        }
        await ClassSession.updateOne({ _id: previous._id }, { $set: { topic: "" } });
    }
    await ClassSession.create({
        course: course._id,
        teacher: course.teacher,
        topic: LIVE_DEMO_TOPIC,
        room: course.room,
        mode: "offline",
        startsAt,
        endsAt,
        status: "scheduled",
        source: "manual",
        stats: { present: 0, late: 0, absent: 0, excused: 0, enrolled: course.students.length },
    });
    return startsAt;
};

const seedAttendance = async (ctx, { now, log }) => {
    const { teachers, students } = ctx;
    const studentsById = new Map(Object.values(students).map((entry) => [String(entry.user._id), entry]));
    const courses = [];
    const liveDemo = {};
    const totals = { created: 0, converted: 0, records: 0 };
    for (const fixture of COURSES) {
        const teacher = teachers[fixture.teacher];
        const studentIds = Object.values(students)
            .filter(({ fixture: s }) => s.branch === canonicalBranch(fixture.branch) && s.section === fixture.section)
            .map(({ user }) => user._id);
        const course = await upsertCourse(fixture, { teacher, studentIds });
        if (course.status !== "active") {
            ctx.warnings.push(`${fixture.code} exists but is ${course.status}; sessions were not generated`);
            courses.push({ course, fixture, teacher });
            continue;
        }
        const past = await seedPastSessions(course, fixture, now);
        totals.created += past.created;
        totals.converted += past.converted;
        const records = await seedRecords(course, fixture, teacher, studentsById, now);
        totals.records += records.inserted;
        await materialiseCourse(course, { days: UPCOMING_DAYS, now });
        courses.push({ course, fixture, teacher });
    }
    // The live demo class goes on each teacher's first course (after materialisation, so a timetable session can be reused).
    for (const teacherFixture of TEACHERS) {
        const first = courses.find(({ fixture }) => fixture.teacher === teacherFixture.key);
        if (first && first.course.status === "active") liveDemo[teacherFixture.key] = await seedLiveDemoClass(first.course, now);
    }
    // Per-student, per-course summaries (the module's own formula).
    const summaries = new Map();
    for (const { course, fixture } of courses) {
        const ended = await ClassSession.find({ course: course._id, status: "ended" }).distinct("_id");
        const rows = await AttendanceRecord.aggregate([
            { $match: { session: { $in: ended } } },
            { $group: { _id: { student: "$student", status: "$status" }, count: { $sum: 1 } } },
        ]);
        const counts = new Map();
        for (const row of rows) {
            const id = String(row._id.student);
            if (!counts.has(id)) counts.set(id, { present: 0, late: 0, absent: 0, excused: 0 });
            counts.get(id)[row._id.status] += row.count;
        }
        const threshold = course.settings?.minAttendancePercent ?? DEFAULT_SETTINGS.minAttendancePercent;
        for (const studentId of course.students.map(String)) {
            const summary = summarise(counts.get(studentId) || {}, threshold);
            const countable = summary.held - summary.excused;
            summaries.set(`${fixture.code}:${studentId}`, {
                ...summary, code: fixture.code, courseId: course._id, threshold,
                needToReach: computeNeedToReach(summary.attended, countable, threshold),
            });
        }
    }
    log(`[seed] attendance: ${courses.length} courses, ${totals.created} sessions created, ${totals.converted} closed, ${totals.records} records added`);
    return { courses, liveDemo, summaries };
};

// ── Placements ──────────────────────────────────────────────────────────────

const timeline = (status, at, actor, note = "") => ({
    status,
    at,
    by: actor?._id ?? null,
    byRole: actor ? actor.role : "system",
    byName: actor?.name || (actor ? "" : "System"),
    note,
});

/** Timeline, appliedAt and decision dates for one seeded application. */
const applicationHistory = (status, drive, { now, student, tpo, recruiterNote }) => {
    const deadline = dayEnd(now, drive.deadline);
    const driveDay = dayStart(now, drive.drive);
    const published = drive.published === null ? now : dayAt(now, drive.published, "10:00");
    const span = Math.max(1, Math.min(deadline, now) - published);
    const appliedAt = new Date(published.getTime() + span * (0.15 + 0.6 * unit(`applied:${drive.key}:${student.email}`)));
    const entries = [timeline("applied", appliedAt, student, "")];
    const after = (base, hours) => new Date(new Date(base).getTime() + hours * 3_600_000);
    const closed = drive.deadline < 0;
    // Closed drives: shortlist on the morning of the drive day, interviews in the afternoon.
    // Open drives: both steps between the application and now.
    const shortlistAt = closed ? after(driveDay, 8) : new Date(appliedAt.getTime() + (now - appliedAt) * 0.45);
    const interviewAt = closed ? after(driveDay, 13) : new Date(shortlistAt.getTime() + (now - shortlistAt) * 0.6);
    const out = { appliedAt, decidedAt: null, withdrawnAt: null };
    switch (status) {
    case "shortlisted":
        entries.push(timeline("shortlisted", shortlistAt, tpo, "Shortlisted for the online test"));
        break;
    case "interview":
        entries.push(timeline("shortlisted", shortlistAt, tpo, "Shortlisted for the online test"));
        entries.push(timeline("interview", interviewAt, tpo, "Cleared the online test; technical interview scheduled"));
        break;
    case "rejected": {
        // Strong candidates were interviewed first; the rest did not clear the online test.
        const interviewed = ["meera", "yash"].includes(student.email.split(".")[0]);
        if (interviewed) {
            entries.push(timeline("shortlisted", shortlistAt, tpo, "Shortlisted for the online test"));
            entries.push(timeline("interview", interviewAt, tpo, "Cleared the online test"));
            out.decidedAt = after(interviewAt, 4);
        } else {
            out.decidedAt = shortlistAt;
        }
        entries.push(timeline("rejected", out.decidedAt, tpo, recruiterNote || ""));
        break;
    }
    case "withdrawn":
        out.withdrawnAt = after(appliedAt, 30);
        entries.push(timeline("withdrawn", out.withdrawnAt, student, "Withdrew to focus on another opportunity"));
        break;
    case "offered":
    case "hired":
        entries.push(timeline("shortlisted", shortlistAt, tpo, "Shortlisted for the online test"));
        entries.push(timeline("interview", interviewAt, tpo, "Cleared the online test"));
        break;
    default:
        break;
    }
    out.timeline = entries;
    return out;
};

const seedPlacements = async (ctx, { now, log, warnings }) => {
    const Job = M("Job");
    const Application = M("Application");
    const Offer = M("Offer");
    const TrainingProgram = M("TrainingProgram");
    const TrainingEnrollment = M("TrainingEnrollment");
    const PlacementPolicy = M("PlacementPolicy");
    const { college, tpo, recruiter, students } = ctx;
    const out = { drives: {}, applications: {}, offers: {}, programs: {} };

    if (PlacementPolicy) {
        await PlacementPolicy.updateOne(
            { college: college._id, academicYear: academicYearFor(now) },
            { $setOnInsert: { ...DEFAULT_POLICY, isActive: true, updatedBy: tpo._id } },
            { upsert: true, setDefaultsOnInsert: true },
        );
    } else warnings.push("skip: PlacementPolicy not registered");

    if (!Job) {
        warnings.push("skip: Job not registered (drives, applications, offers)");
    } else {
        for (const drive of DRIVES) {
            const company = await findOrCreateCompany(drive.company);
            const creator = drive.byRecruiter ? recruiter : tpo;
            const deadline = dayEnd(now, drive.deadline);
            const driveDate = dayAt(now, drive.drive, "09:30");
            const publishedAt = drive.published === null ? null : dayAt(now, drive.published, "10:00");
            const onInsert = {
                description: drive.description,
                salary: `${drive.ctc} LPA`,
                packageLpa: drive.ctc,
                packageMaxLpa: null,
                eligibleBranches: canonicalBranchList(drive.branches),
                location: drive.location,
                employmentType: "Full-time",
                minimumCgpa: drive.minCgpa,
                maximumBacklogs: drive.maxBacklogs,
                ...(drive.min10 ? { min10thPercentage: drive.min10 } : {}),
                ...(drive.min12 ? { min12thPercentage: drive.min12 } : {}),
                graduationYears: [PASSING_YEAR],
                skills: drive.skills,
                selectionProcess: SELECTION_PROCESS,
                rounds: [
                    { name: "Online test", at: driveDate, venue: "Online (proctored)", mode: "online", notes: "Aptitude, coding and CS fundamentals" },
                    { name: "Technical interview", at: dayAt(now, drive.drive, "13:00"), venue: "Placement Cell, Block A", mode: "offline", notes: "" },
                    { name: "HR", at: dayAt(now, drive.drive, "16:30"), venue: "Placement Cell, Block A", mode: "offline", notes: "" },
                ],
                applicationDeadline: deadline,
                driveDate,
                status: drive.status,
                college: college._id,
                createdByRole: drive.byRecruiter ? "company" : "tpo",
                publishedAt,
                // Announced by the seed's own notifications, never by the module's fan-out.
                notifiedAt: publishedAt,
                closedAt: drive.status === "closed" ? deadline : null,
                closedReason: drive.status === "closed" ? "deadline" : null,
            };
            const job = await Job.findOneAndUpdate(
                { createdBy: creator._id, title: drive.title, company: company._id },
                { $setOnInsert: onInsert },
                { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true },
            ).lean();
            out.drives[drive.key] = { job, drive, company };
        }
    }

    if (Job && Application) {
        for (const [driveKey, studentKey, status] of APPLICATIONS) {
            const { job, drive, company } = out.drives[driveKey];
            const { user } = students[studentKey];
            const existing = await Application.findOne({ job: job._id, student: user._id }).lean();
            if (existing) {
                out.applications[`${driveKey}:${studentKey}`] = existing;
                continue;
            }
            const facts = studentFacts(user);
            const eligibility = await evaluateForJob(user, job);
            const override = !eligibility.eligible;
            const history = applicationHistory(status, drive, {
                now, student: user, tpo,
                recruiterNote: status === "rejected" ? "Thank you for applying. You were not selected this time." : "",
            });
            if (override) {
                history.timeline[0] = timeline("applied", history.appliedAt, tpo, "Added by the placement office (eligibility override)");
            }
            const snapshot = {
                eligible: eligibility.eligible,
                status: override ? "override" : eligibility.status,
                code: eligibility.code ?? null,
                reasons: eligibility.reasons ?? [],
                missing: eligibility.missing ?? [],
                checks: eligibility.checks ?? [],
                policy: eligibility.policy ?? undefined,
                profile: { ...facts },
                evaluatedAt: history.appliedAt,
            };
            await Application.updateOne(
                { job: job._id, student: user._id },
                {
                    $setOnInsert: {
                        college: job.college ?? college._id,
                        company: company._id,
                        academicYear: academicYearFor(history.appliedAt),
                        status,
                        timeline: history.timeline,
                        resume: null,
                        coverNote: "",
                        eligibilitySnapshot: snapshot,
                        eligibilityOverride: override
                            ? { by: tpo._id, byName: tpo.name, at: history.appliedAt, note: "CGPA is 0.1 below the cut-off; the recruiter agreed to consider the profile." }
                            : null,
                        source: override ? "tpo" : "web",
                        offer: null,
                        appliedAt: history.appliedAt,
                        decidedAt: history.decidedAt,
                        withdrawnAt: history.withdrawnAt,
                    },
                },
                { upsert: true, setDefaultsOnInsert: true },
            );
            out.applications[`${driveKey}:${studentKey}`] = await Application.findOne({ job: job._id, student: user._id }).lean();
        }
    } else if (Job) warnings.push("skip: Application not registered");

    if (Job && Application && Offer) {
        const offerSpecs = [
            {
                key: "aarav", appKey: "msft-swe:aarav", packageLpa: 44, roleTitle: "Software Engineer", joiningDate: "2027-07-15",
                status: "accepted", createdAt: daysFrom(now, -4), respondedAt: daysFrom(now, -3),
            },
            {
                key: "diya", appKey: "razorpay-be:diya", packageLpa: 24, roleTitle: "Backend Engineer", joiningDate: "2027-07-01",
                status: "extended", createdAt: minutesFrom(now, -10 * 60), expiresAt: daysFrom(now, 5),
            },
        ];
        for (const spec of offerSpecs) {
            const application = out.applications[spec.appKey];
            if (!application) continue;
            const { job, drive, company } = out.drives[spec.appKey.split(":")[0]];
            const { user } = students[spec.key];
            const history = [{ status: "extended", changedAt: spec.createdAt, by: tpo._id, byRole: "tpo", byName: tpo.name, note: "Offer extended" }];
            if (spec.status === "accepted") {
                history.push({ status: "accepted", changedAt: spec.respondedAt, by: user._id, byRole: "student", byName: user.name, note: "Offer accepted" });
            }
            await Offer.updateOne(
                { application: application._id },
                {
                    $setOnInsert: {
                        student: user._id,
                        job: job._id,
                        company: company._id,
                        college: college._id,
                        companyName: drive.company,
                        roleTitle: spec.roleTitle,
                        packageLpa: spec.packageLpa,
                        ctcText: `${spec.packageLpa} LPA`,
                        offerType: "normal",
                        status: spec.status,
                        expiresAt: spec.expiresAt || daysFrom(spec.createdAt, DEFAULT_POLICY.offerExpiryDays),
                        joiningDate: DateTime.fromISO(spec.joiningDate, { zone: TZ }).startOf("day").toJSDate(),
                        location: drive.location,
                        academicYear: academicYearFor(spec.createdAt),
                        statusHistory: history,
                        respondedAt: spec.respondedAt || null,
                        createdBy: tpo._id,
                        createdByRole: "tpo",
                        createdAt: spec.createdAt,
                        updatedAt: spec.respondedAt || spec.createdAt,
                    },
                },
                { upsert: true, setDefaultsOnInsert: true, timestamps: false },
            );
            const offer = await Offer.findOne({ application: application._id }).lean();
            out.offers[spec.key] = offer;
            // Mirror the offer onto the application the way syncFromOffer does (extended → offered, accepted → hired).
            if (!application.offer) {
                const target = offer.status === "accepted" ? "hired" : offer.status === "extended" ? "offered" : application.status;
                const update = { $set: { offer: offer._id } };
                const hasEntry = (application.timeline || []).some((entry) => entry.status === target);
                if (!hasEntry) {
                    const entries = [timeline("offered", spec.createdAt, tpo, `Offer extended: ${spec.packageLpa} LPA`)];
                    if (target === "hired") entries.push(timeline("hired", spec.respondedAt, user, "Offer accepted"));
                    update.$push = { timeline: { $each: entries } };
                    if (target === "hired") update.$set.decidedAt = spec.respondedAt;
                }
                await Application.updateOne({ _id: application._id, offer: null }, update);
            }
        }
    } else if (Job && Application) warnings.push("skip: Offer not registered");

    if (TrainingProgram && TrainingEnrollment) {
        const today = local(now).startOf("day");
        const nextMonday = today.plus({ days: ((8 - today.weekday) % 7) || 7 });
        const schedules = {
            "Aptitude & Reasoning Bootcamp": [0, 2, 4, 5].map((offset, index) => ({
                date: nextMonday.plus({ days: offset }).toJSDate(), time: "16:00-17:30", venue: "Online (Google Meet)", durationMinutes: 90,
                topic: ["Quantitative aptitude", "Logical reasoning", "Verbal ability", "Full-length mock test"][index],
            })),
            "DSA Interview Sprint": [-7, -4, 0, 3, 7, 10].map((offset, index) => ({
                date: today.plus({ days: offset }).toJSDate(), time: "18:00-19:30", venue: "LT-1", durationMinutes: 90,
                topic: ["Arrays and hashing", "Linked lists and stacks", "Trees and BST", "Graphs: BFS and DFS", "Dynamic programming", "Mock coding round"][index],
            })),
            "Mock Interview Week": [1, 3, 5].map((offset, index) => ({
                date: nextMonday.plus({ days: offset }).toJSDate(), time: "10:00-13:00", venue: "Placement Cell + Google Meet", durationMinutes: 180,
                topic: ["Technical mock interviews", "HR and behavioural rounds", "Group discussion and feedback"][index],
            })),
        };
        const todayKey = today.toFormat("yyyy-LL-dd");
        for (const fixture of TRAINING) {
            const schedule = schedules[fixture.title];
            const days = schedule.map((session) => local(session.date).toFormat("yyyy-LL-dd")).sort();
            const status = days[0] > todayKey ? "upcoming" : days[days.length - 1] < todayKey ? "completed" : "ongoing";
            const firstDay = local(schedule[0].date);
            await TrainingProgram.updateOne(
                { title: fixture.title, createdBy: tpo._id },
                {
                    $setOnInsert: {
                        college: college._id,
                        description: fixture.description,
                        type: fixture.type,
                        instructor: fixture.instructor,
                        deliveryMode: fixture.deliveryMode,
                        capacity: fixture.capacity,
                        status,
                        schedule,
                        registrationDeadline: status === "upcoming" ? firstDay.minus({ days: 1 }).endOf("day").toJSDate() : null,
                        audience: { ...fixture.audience, branches: canonicalBranchList(fixture.audience.branches) },
                    },
                },
                { upsert: true, setDefaultsOnInsert: true },
            );
            const program = await TrainingProgram.findOne({ title: fixture.title, createdBy: tpo._id }).lean();
            const pastIndexes = program.schedule
                .map((session, index) => ({ index, key: local(session.date).toFormat("yyyy-LL-dd"), date: session.date }))
                .filter((session) => session.key < todayKey);
            for (const studentKey of fixture.students) {
                const { user } = students[studentKey];
                const attendance = pastIndexes
                    .filter(({ index }) => unit(`training:${fixture.title}:${index}:${studentKey}`) < 0.85)
                    .map(({ index, date }) => ({ sessionIndex: index, date, markedAt: date, markedBy: tpo._id, method: "manual" }));
                await TrainingEnrollment.updateOne(
                    { program: program._id, student: user._id },
                    {
                        $setOnInsert: {
                            status: "registered",
                            completionStatus: program.status === "ongoing" ? "in-progress" : program.status === "completed" ? "completed" : "enrolled",
                            attendance,
                            registeredAt: daysFrom(now, -2 - 3 * unit(`reg:${studentKey}:${fixture.title}`)),
                        },
                    },
                    { upsert: true, setDefaultsOnInsert: true },
                );
            }
            // Denormalised seat count = registered enrolments.
            const registered = await TrainingEnrollment.countDocuments({ program: program._id, status: "registered" });
            await TrainingProgram.updateOne({ _id: program._id }, { $set: { enrolledCount: Math.min(registered, program.capacity) } });
            out.programs[fixture.title] = program;
        }
    } else warnings.push("skip: TrainingProgram/TrainingEnrollment not registered");

    log(`[seed] placements: ${Object.keys(out.drives).length} drives, ${Object.keys(out.applications).length} applications, ${Object.keys(out.offers).length} offers, ${Object.keys(out.programs).length} training programs`);
    return out;
};

// ── Job feed ────────────────────────────────────────────────────────────────

const seedJobFeed = async (ctx, { now, log, warnings }) => {
    const result = await seedSampleExternalJobs({ now });
    let saved = 0;
    for (const [studentKey, title, status, notes] of SAVED_JOBS) {
        const job = await ExternalJob.findOne({ isSample: true, title }).select("_id").lean();
        if (!job) {
            warnings.push(`job-feed: sample listing "${title}" not found; tracker entry skipped`);
            continue;
        }
        const { created } = await upsertSavedJob({ user: ctx.students[studentKey].user._id, jobId: job._id, status, notes, now });
        if (created) saved += 1;
    }
    log(`[seed] job feed: ${result.inserted} sample listings inserted (${result.existing} already present), ${saved} tracker entries created`);
    return result;
};

// ── Issue reports ───────────────────────────────────────────────────────────

const seedIssueReports = async (ctx, { warnings }) => {
    const IssueReport = M("IssueReport");
    if (!IssueReport) {
        warnings.push("skip: IssueReport not registered");
        return;
    }
    for (const report of ISSUE_REPORTS) {
        const { user } = ctx.students[report.student];
        await IssueReport.updateOne(
            { email: user.email, description: report.description },
            {
                $setOnInsert: {
                    name: user.name,
                    page: report.page,
                    user: user._id,
                    role: "student",
                    college: ctx.college._id,
                    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1",
                    status: report.status,
                    ...(report.note ? { note: report.note, handledBy: ctx.tpo._id } : {}),
                },
            },
            { upsert: true, setDefaultsOnInsert: true },
        );
    }
};

// ── Notifications ───────────────────────────────────────────────────────────

const seedNotifications = async (ctx, attendance, placements, { log }) => {
    const { students, teachers, tpo, recruiter, alumni } = ctx;
    let created = 0;
    const send = async (userIds, key, payload) => {
        const result = await notify(userIds, { ...payload, dedupeKey: `demo:${key}`, email: false, push: false });
        created += result.created;
    };
    const allStudents = Object.values(students).map(({ user }) => user._id);

    await send(allStudents, "welcome", { type: "system", title: `Welcome to ${COLLEGE_NAME} on Matchy Campus`, body: "Your attendance, campus drives and training programs are all in one place.", ui: { panel: "student.home" } });
    for (const teacher of Object.values(teachers)) {
        await send(teacher._id, "welcome", { type: "system", title: "Welcome to Matchy Campus", body: "Your courses, timetable and attendance reports are ready.", ui: { panel: "teacher.home" } });
    }
    await send(tpo._id, "welcome", { type: "system", title: "Welcome to the placement office console", body: "Drives, applicants, offers, training and faculty are ready for the demo.", ui: { panel: "tpo.home" } });
    for (const { user } of alumni) {
        await send(user._id, "welcome", { type: "system", title: `Thanks for mentoring ${COLLEGE_NAME} students`, body: "Students can now send you mentorship requests.", ui: { panel: "alumni" } });
    }
    await send(recruiter._id, "welcome", { type: "system", title: "Welcome to the recruiter console", body: `You can post drives for ${COLLEGE_NAME}; the placement office approves them.`, ui: { panel: "company.home" } });

    const atlassian = placements.drives["atlassian-gse"]?.job;
    if (atlassian) {
        await send(allStudents, "drive.new:atlassian-gse", {
            type: "placement.drive.new", title: "New drive: Atlassian, Graduate Software Engineer",
            body: `52 LPA · Bengaluru · apply by ${local(atlassian.applicationDeadline).toFormat("d LLL")}`,
            ui: { panel: "jobs.detail", params: { jobId: idStr(atlassian._id) } }, data: { jobId: idStr(atlassian._id) },
        });
    }
    const mock = placements.programs["Mock Interview Week"];
    if (mock) {
        await send(allStudents, "training.new:mock-interview-week", {
            type: "training.new", title: "New training: Mock Interview Week",
            body: "Three sessions next week with alumni mentors. Seats are limited.", ui: { panel: "training" }, data: { programId: idStr(mock._id) },
        });
    }
    const aaravOffer = placements.offers.aarav;
    if (aaravOffer) {
        await send(students.aarav.user._id, "offer.accepted:aarav", {
            type: "placement.offer.updated", title: "Offer accepted: Microsoft", body: "44 LPA · Software Engineer · joining 15 Jul 2027",
            ui: { panel: "offers" }, data: { offerId: idStr(aaravOffer._id), status: aaravOffer.status },
        });
        await send(tpo._id, "offer.accepted:aarav", {
            type: "placement.offer.updated", title: "Aarav Gupta accepted the Microsoft offer", body: "44 LPA · Software Engineer",
            ui: { panel: "tpo.offers", params: { offerId: idStr(aaravOffer._id) } }, data: { offerId: idStr(aaravOffer._id), status: aaravOffer.status },
        });
    }
    const diyaOffer = placements.offers.diya;
    if (diyaOffer) {
        await send(students.diya.user._id, "offer.new:diya", {
            type: "placement.offer.new", title: "New offer from Razorpay: 24 LPA",
            body: `Backend Engineer · respond by ${local(diyaOffer.expiresAt).toFormat("d LLL")}`,
            ui: { panel: "offers" }, data: { offerId: idStr(diyaOffer._id) }, priority: "high",
        });
    }
    const sneha = placements.applications["zomato-da:sneha"];
    if (sneha) {
        await send(students.sneha.user._id, "application.status:zomato-da:sneha", {
            type: "placement.application.status", title: "Your Zomato application moved to Interview",
            body: "You have been moved to the interview round.", ui: { panel: "applications" }, data: { applicationId: idStr(sneha._id), status: "interview" },
        });
    }
    const acme = placements.drives["acme-ase"]?.job;
    if (acme) {
        await send(tpo._id, "drive.pending:acme-ase", {
            type: "placement.drive.pending", title: `Drive awaiting approval: ${RECRUITER.companyName} – ${acme.title}`,
            body: `Submitted by ${recruiter.name}.`, ui: { panel: "tpo.drives", params: { jobId: idStr(acme._id), status: "pending" } },
            data: { jobId: idStr(acme._id) }, priority: "high",
        });
        await send(recruiter._id, "drive.submitted:acme-ase", {
            type: "system", title: `Drive submitted for approval: ${acme.title}`,
            body: "The placement office will review it shortly.", ui: { panel: "company.drives", params: { jobId: idStr(acme._id) } }, data: { jobId: idStr(acme._id) },
        });
    }

    // Attendance: each student below 75% in a course, and a digest per teacher course.
    const lowByCourse = new Map();
    for (const summary of attendance.summaries.values()) {
        if (summary.percent === null || summary.percent >= summary.threshold) continue;
        if (!lowByCourse.has(summary.code)) lowByCourse.set(summary.code, []);
        lowByCourse.get(summary.code).push(summary);
    }
    for (const [key, summary] of attendance.summaries) {
        if (summary.percent === null || summary.percent >= summary.threshold) continue;
        const studentId = key.split(":")[1];
        const classes = summary.needToReach;
        await send(studentId, `attendance.low:${summary.code}`, {
            type: "attendance.low", title: `Your attendance in ${summary.code} is ${summary.percent}%`,
            body: `Attend the next ${classes} class${classes === 1 ? "" : "es"} to reach ${summary.threshold}%.`,
            ui: { panel: "attendance.student", params: { courseId: idStr(summary.courseId) } }, data: { courseId: idStr(summary.courseId), percent: summary.percent },
        });
    }
    for (const { course, fixture, teacher } of attendance.courses) {
        const low = lowByCourse.get(fixture.code) || [];
        if (!low.length) continue;
        await send(teacher._id, `teacher.low:${fixture.code}`, {
            type: "system", title: `${low.length} student${low.length === 1 ? "" : "s"} in ${fixture.code} ${low.length === 1 ? "is" : "are"} below 75%`,
            body: "Open course analytics to see who needs a nudge.", ui: { panel: "teacher.analytics", params: { courseId: idStr(course._id) } },
            data: { courseId: idStr(course._id), count: low.length },
        });
    }
    log(`[seed] notifications: ${created} created`);
};

// ── Summary data ────────────────────────────────────────────────────────────

const countAll = async (ctx, attendance) => {
    const userIds = (await User.find({ $or: [{ email: DEMO_EMAIL_RE }, { college: ctx.college._id }] }).distinct("_id"));
    const courseIds = attendance.courses.map(({ course }) => course._id);
    const count = async (name, filter) => (M(name) ? M(name).countDocuments(filter) : 0);
    const jobIds = M("Job") ? await M("Job").find({ college: ctx.college._id }).distinct("_id") : [];
    return {
        users: userIds.length,
        courses: courseIds.length,
        sessionsEnded: await ClassSession.countDocuments({ course: { $in: courseIds }, status: "ended" }),
        sessionsUpcoming: await ClassSession.countDocuments({ course: { $in: courseIds }, status: { $in: ["scheduled", "live"] } }),
        records: await AttendanceRecord.countDocuments({ course: { $in: courseIds } }),
        drives: jobIds.length,
        applications: await count("Application", { job: { $in: jobIds } }),
        offers: await count("Offer", { student: { $in: userIds } }),
        training: await count("TrainingProgram", { college: ctx.college._id }),
        enrolments: await count("TrainingEnrollment", { student: { $in: userIds } }),
        notifications: await count("Notification", { user: { $in: userIds } }),
        externalJobs: await ExternalJob.countDocuments({ isSample: true }),
        savedJobs: await count("SavedJob", { user: { $in: userIds } }),
    };
};

const buildAccounts = (ctx, attendance, placements, now) => {
    const accounts = [];
    accounts.push({ role: "TPO", email: ctx.tpo.email, notes: "College TPO · approves the Acme drive" });
    for (const fixture of TEACHERS) {
        const teacher = ctx.teachers[fixture.key];
        const courses = attendance.courses.filter((entry) => entry.fixture.teacher === fixture.key)
            .map(({ fixture: c }) => `${c.code} (${c.branch}-${c.section})`).join(", ");
        const live = attendance.liveDemo[fixture.key];
        accounts.push({ role: "Teacher", email: teacher.email, notes: `${courses}${live ? `; live demo class ${describeTime(live, now)}` : ""}` });
    }
    for (const { user, fixture } of ctx.alumni) accounts.push({ role: "Alumni", email: user.email, notes: `${fixture.company}, ${fixture.currentRole}` });
    accounts.push({ role: "Recruiter", email: ctx.recruiter.email, notes: `${RECRUITER.companyName} · 1 drive pending approval` });
    for (const { user, fixture } of Object.values(ctx.students)) {
        const parts = [`${fixture.branch}-${fixture.section}`, `CGPA ${fixture.cgpa.toFixed(2)}`];
        const summary = [...attendance.summaries.entries()].find(([key]) => key.endsWith(`:${user._id}`))?.[1];
        if (summary?.percent !== null && summary?.percent !== undefined) {
            parts.push(`attendance ${Math.round(summary.percent)}%${summary.percent < summary.threshold ? " (below 75%)" : ""}`);
        }
        if (fixture.activeBacklogs) parts.push(`${fixture.activeBacklogs} backlog${fixture.activeBacklogs === 1 ? "" : "s"}`);
        const offer = placements.offers[fixture.key];
        if (offer) parts.push(`offer ${offer.status === "extended" ? "pending" : offer.status} (${offer.companyName})`);
        accounts.push({ role: "Student", email: user.email, notes: parts.join(" · ") });
    }
    return accounts;
};

// ── seedDemo ────────────────────────────────────────────────────────────────

/**
 * Create or top up the demo dataset. Never logs the password.
 * @returns {Promise<{accounts: Array<{role, email, notes}>, counts: object, warnings: string[], notes: string[]}>}
 */
export const seedDemo = async ({ password, now = new Date(), log = console.log } = {}) => {
    if (typeof password !== "string" || password.length < PASSWORD_MIN) throw new Error("seedDemo needs the demo password (at least 8 characters)");
    const warnings = [];
    const passwordHash = await bcrypt.hash(password, 10);

    const ctx = await seedIdentity({ passwordHash, log, warnings });
    ctx.warnings = warnings;
    const attendance = await seedAttendance(ctx, { now, log });
    const placements = await seedPlacements(ctx, { now, log, warnings });
    await seedJobFeed(ctx, { now, log, warnings });
    await seedIssueReports(ctx, { warnings });
    await seedNotifications(ctx, attendance, placements, { log });

    const counts = await countAll(ctx, attendance);
    const accounts = buildAccounts(ctx, attendance, placements, now);
    return { accounts, counts, warnings, notes: ctx.notes };
};

// ── wipeDemo ────────────────────────────────────────────────────────────────

/** Delete documents of `modelName` where any existing candidate path references one of `ids`. */
const deleteWhereAnyRef = async (modelName, groups, deleted, warnings) => {
    const model = M(modelName);
    if (!model) return 0;
    const or = [];
    for (const [paths, ids] of groups) {
        if (!ids?.length) continue;
        for (const path of paths) if (model.schema.path(path)) or.push({ [path]: { $in: ids } });
    }
    if (!or.length) {
        if (!groups.some(([paths]) => paths.some((path) => model.schema.path(path)))) warnings.push(`wipe: ${modelName} has none of the reference paths; skipped`);
        return 0;
    }
    const { deletedCount = 0 } = await model.deleteMany({ $or: or });
    deleted[modelName] = (deleted[modelName] || 0) + deletedCount;
    return deletedCount;
};

/**
 * Delete exactly the demo data (dependency order). Non-demo data is never touched.
 * @returns {Promise<{deleted: Record<string, number>, warnings: string[]}>}
 */
export const wipeDemo = async ({ log = console.log } = {}) => {
    const deleted = {};
    const warnings = [];
    // Interviews live outside the module registry; load the model so their owners' rows are wiped too.
    try {
        await import("../src/models/interview.model.js");
    } catch (error) {
        warnings.push(`wipe: Interview model unavailable (${error?.message || error})`);
    }

    const college = await College.findOne({ domain: DOMAIN }).lean();
    const userFilter = college ? { $or: [{ email: DEMO_EMAIL_RE }, { college: college._id }] } : { email: DEMO_EMAIL_RE };
    const userIds = await User.find(userFilter).distinct("_id");
    const courseIds = userIds.length ? await Course.find({ teacher: { $in: userIds } }).distinct("_id") : [];
    const jobFilter = { $or: [{ createdBy: { $in: userIds } }, ...(college ? [{ college: college._id }] : [])] };
    const jobIds = M("Job") ? await M("Job").find(jobFilter).distinct("_id") : [];
    const programIds = M("TrainingProgram") ? await M("TrainingProgram").find(jobFilter).distinct("_id") : [];
    const applicationIds = M("Application")
        ? await M("Application").find({ $or: [{ student: { $in: userIds } }, { job: { $in: jobIds } }] }).distinct("_id")
        : [];
    const connectionIds = M("AlumniConnection")
        ? await M("AlumniConnection").find({ $or: [{ student: { $in: userIds } }, { alumniUser: { $in: userIds } }] }).distinct("_id")
        : [];

    const userRefs = ["student", "user", "applicant", "owner"];
    await deleteWhereAnyRef("AttendanceRecord", [[["course"], courseIds], [["student"], userIds]], deleted, warnings);
    await deleteWhereAnyRef("ClassSession", [[["course"], courseIds]], deleted, warnings);
    await deleteWhereAnyRef("Course", [[["_id"], courseIds]], deleted, warnings);
    // Demo students who joined a non-demo course leave its roster.
    if (userIds.length) await Course.updateMany({ students: { $in: userIds } }, { $pull: { students: { $in: userIds } } });

    for (const name of ["Offer", "Application", "TrainingEnrollment"]) {
        await deleteWhereAnyRef(name, [
            [userRefs, userIds],
            [["job", "drive"], jobIds],
            [["program"], programIds],
            [["application"], applicationIds],
        ], deleted, warnings);
    }
    await deleteWhereAnyRef("Job", [[["_id"], jobIds]], deleted, warnings);
    for (const name of ["TrainingProgram", "PlacementPolicy"]) {
        await deleteWhereAnyRef(name, [[["createdBy", "updatedBy"], userIds], [["college"], college ? [college._id] : []]], deleted, warnings);
    }
    for (const name of ["Notification", "PushSubscription", "AgentToolCall", "AuthSession", "SavedJob"]) {
        await deleteWhereAnyRef(name, [[["user"], userIds]], deleted, warnings);
    }
    await deleteWhereAnyRef("JobSyncRun", [[["triggeredBy"], userIds]], deleted, warnings);
    const purged = await purgeResumesForUsers(userIds);
    deleted.Resume = purged.resumes;
    deleted.JobDescriptionOverride = purged.overrides;
    await deleteWhereAnyRef("MentorshipMessage", [[["sender"], userIds], [["connection"], connectionIds]], deleted, warnings);
    for (const name of ["Interview", "AlumniConnection"]) {
        await deleteWhereAnyRef(name, [[["student", "user", "owner", "sender", "alumniUser"], userIds]], deleted, warnings);
    }
    await deleteWhereAnyRef("AlumniProfile", [[["user"], userIds]], deleted, warnings);
    if (M("IssueReport")) {
        const { deletedCount = 0 } = await M("IssueReport").deleteMany({ $or: [{ user: { $in: userIds } }, { email: DEMO_EMAIL_RE }] });
        deleted.IssueReport = deletedCount;
    }
    deleted.Student = (await Student.deleteMany({ email: DEMO_EMAIL_RE })).deletedCount || 0;
    deleted.User = userIds.length ? (await User.deleteMany({ _id: { $in: userIds } })).deletedCount || 0 : 0;
    deleted.College = college ? (await College.deleteOne({ _id: college._id })).deletedCount || 0 : 0;
    const samples = await removeSampleJobs();
    deleted.ExternalJob = samples.deleted;
    deleted.SavedJob = (deleted.SavedJob || 0) + samples.savedEntriesDeleted;

    const summary = Object.entries(deleted).filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`).join(", ");
    log(`[seed] wiped demo data: ${summary || "nothing to delete"}`);
    return { deleted, warnings };
};

// ── CLI ─────────────────────────────────────────────────────────────────────

const printSummary = ({ accounts, counts, warnings, notes }, password) => {
    const conn = mongoose.connection;
    const roleWidth = Math.max(4, ...accounts.map((a) => a.role.length)) + 2;
    const emailWidth = Math.max(5, ...accounts.map((a) => a.email.length)) + 2;
    const lines = [
        "",
        `Matchy Campus demo data: ${COLLEGE_NAME} (${DOMAIN})`,
        `Database: ${conn.host}:${conn.port}/${conn.name}`,
        `Password for ALL demo accounts: ${password}   (shown once; set DEMO_PASSWORD to choose your own)`,
        "",
        `${pad("Role", roleWidth)}${pad("Email", emailWidth)}Notes`,
        ...accounts.map((a) => `${pad(a.role, roleWidth)}${pad(a.email, emailWidth)}${a.notes}`),
        "",
        `Counts: users ${counts.users} · courses ${counts.courses} · sessions ${counts.sessionsEnded + counts.sessionsUpcoming} (${counts.sessionsEnded} ended / ${counts.sessionsUpcoming} upcoming) · records ${counts.records} · drives ${counts.drives} · applications ${counts.applications} · offers ${counts.offers} · training ${counts.training} (${counts.enrolments} enrolments) · notifications ${counts.notifications} · external jobs ${counts.externalJobs} (${counts.savedJobs} saved)`,
    ];
    for (const note of notes || []) lines.push(`Note: ${note}`);
    if (warnings.length) lines.push(`Warnings: ${warnings.join("; ")}`);
    console.log(lines.join("\n"));
};

// MongoDB "IndexOptionsConflict" / "IndexKeySpecsConflict": an index left by an older schema.
const INDEX_CONFLICT_CODES = new Set([85, 86]);

/**
 * init() every registered model (builds indexes). A stale index whose options differ
 * from the schema is reported, not fatal: the owning module fixes it at server boot
 * (e.g. resume-lab start() → Resume.syncIndexes()).
 */
const initIndexes = async () => {
    const warnings = [];
    const results = await Promise.allSettled(Object.values(mongoose.models).map(async (model) => {
        try {
            await model.init();
        } catch (error) {
            if (!INDEX_CONFLICT_CODES.has(error?.code)) throw error;
            const name = /name: "([^"]+)"/.exec(error?.message || "")?.[1] || "?";
            warnings.push(`index conflict on ${model.modelName} (${model.collection.collectionName}.${name}); start the API once or run the owning module's migration to sync it`);
        }
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return warnings;
};

const main = async () => {
    let args;
    let password = null;
    try {
        args = parseSeedArgs(process.argv.slice(2));
        const refusal = productionGuard(args);
        if (refusal) throw new Error(refusal);
        if (args.seed) password = resolveDemoPassword(process.env);
    } catch (error) {
        console.error(`[seed] ${error.message}`);
        process.exit(1);
    }
    try {
        await DBConnect();
        await import("../src/modules/index.js"); // registers every module's models; nothing is started
        const initWarnings = await initIndexes();
        if (args.reset) {
            const { warnings } = await wipeDemo();
            if (!args.seed && [...initWarnings, ...warnings].length) console.log(`Warnings: ${[...initWarnings, ...warnings].join("; ")}`);
        }
        if (args.seed) {
            const result = await seedDemo({ password });
            result.warnings.unshift(...initWarnings);
            printSummary(result, password);
        }
        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error(`[seed] failed: ${error?.message || error}`);
        if (process.env.SEED_DEBUG === "true") console.error(error);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    }
};

const invokedDirectly = (() => {
    try {
        return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();

if (invokedDirectly) await main();
