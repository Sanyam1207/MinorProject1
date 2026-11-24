// Deterministic ATS scorer (docs/contracts/RESUME-BYOK.md §5, acceptance tests A1–A5, A7, A8 of §19).
// Pure tests: no database, no network.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SCORER_VERSION,
    canonicalizeSkill,
    findSkillTerms,
    gradeFor,
    scoreResume,
} from "../src/modules/resume-lab/ats/scorer.js";
import { isQuantifiedBullet } from "../src/modules/resume-lab/ats/text.js";
import { ACTION_VERBS, SKILL_TERMS } from "../src/modules/resume-lab/ats/lexicon.js";

const EMAIL = "arjun.sharma@example.com";

// Every section, email, phone, LinkedIn, GitHub; 8 bullets: 5 quantified, 6 start with action verbs.
const STRONG = `Arjun Sharma
Bengaluru, India | ${EMAIL} | +91 98765 43210 | linkedin.com/in/arjun-sharma | github.com/arjunsharma

Summary
Full-stack software engineer and final-year computer science student who builds reliable web platforms with JavaScript, TypeScript, React and Node.js. Comfortable owning features end to end, from database schema design in PostgreSQL and MongoDB to automated testing with Jest and cloud deployment on AWS. Looking for a backend or full-stack engineering role on a team that ships often, reviews code carefully and measures the product impact of every release.

Education
B.Tech in Computer Science and Engineering, Delhi Technological University, New Delhi, 2021 – 2025
CGPA 8.7 out of 10; coursework in data structures, algorithms, operating systems, computer networks, DBMS and software engineering
Senior Secondary (CBSE), Delhi Public School, R. K. Puram, 2021, with a focus on mathematics, physics and computer science

Experience
Software Engineering Intern, Flipkart, Bengaluru, May 2024 – July 2024
• Built a Node.js and Express.js checkout service that cut API latency by 35% for two million monthly shoppers.
• Designed PostgreSQL indexes and query plans that reduced nightly report generation from 40 minutes to 6 minutes.
• Implemented automated Jest and Cypress test suites, raising backend coverage from 52% to 88% across twelve services.
• Collaborated with product managers to document internal APIs in a shared developer portal used by several teams.
Web Development Intern, Zomato, Gurugram, June 2023 – August 2023
Worked with the restaurant onboarding team on internal tools, code reviews and weekly demos to stakeholders.

Projects
CampusConnect, React, TypeScript, MongoDB
• Developed a React and TypeScript placement portal adopted by 1,200 students during the 2024 campus hiring season.
• Optimized MongoDB aggregation pipelines so that dashboard pages load noticeably faster for students and coordinators.
• Deployed the application on AWS with GitHub Actions continuous deployment, achieving 99.9% uptime over six months.
• Onboarding documentation and walkthrough videos were prepared so that new contributors could start contributing quickly.

Technical Skills
Languages: JavaScript, TypeScript, Python, Java, SQL, HTML, CSS
Frameworks and libraries: React, Node.js, Express.js, Next.js, Tailwind CSS, Jest, Cypress
Tools and platforms: Git, GitHub Actions, AWS, Linux, PostgreSQL, MongoDB, Postman

Achievements
Winner of the Smart India Hackathon 2023 software edition, national finals among one hundred and twenty teams
Secured a top two percent rank in the Google Kick Start 2023 coding round and mentored juniors in the coding club
Volunteer teaching assistant for the first-year programming lab, running weekly doubt-clearing sessions for students
`;

const bullet = (text) => `• ${text}`;

/** A compact resume with the given experience bullets (used to isolate single checks). */
const resumeWithBullets = (bullets) => `Riya Verma
riya@example.com | +91 91234 56789

Education
B.Tech Information Technology, 2022 – 2026

Experience
${bullets.map(bullet).join("\n")}

Skills
React, Node.js, MongoDB
`;

const check = (result, id) => result.breakdown.find((item) => item.id === id);
const withoutComputed = (value) => JSON.parse(JSON.stringify(value));

describe("ATS scorer — lexicon sanity", () => {
    it("has at least 150 skill terms and 60 action verbs; weights sum to 100", () => {
        assert.ok(Object.keys(SKILL_TERMS).length >= 150, `only ${Object.keys(SKILL_TERMS).length} skill terms`);
        assert.ok(ACTION_VERBS.size >= 60, `only ${ACTION_VERBS.size} action verbs`);
        const result = scoreResume({ text: STRONG });
        assert.equal(result.breakdown.reduce((sum, item) => sum + item.weight, 0), 100);
        assert.deepEqual(result.breakdown.map((item) => item.id),
            ["sections", "contact", "keywords", "impact", "action_verbs", "length", "readability", "depth"]);
        assert.equal(result.scorerVersion, SCORER_VERSION);
        assert.equal(SCORER_VERSION, "ats-v1");
    });

    it("canonicalizes aliases", () => {
        assert.equal(canonicalizeSkill("Node"), "node.js");
        assert.equal(canonicalizeSkill("K8s"), "kubernetes");
        assert.equal(canonicalizeSkill("Postgres"), "postgresql");
        assert.equal(canonicalizeSkill("Scikit-Learn"), "scikit-learn");
        assert.equal(canonicalizeSkill("Some Niche Tool"), "some niche tool");
        assert.equal(canonicalizeSkill("  "), "");
    });

    it("grades by thresholds", () => {
        assert.deepEqual([90, 85, 84, 70, 69, 55, 54, 0].map(gradeFor), ["A", "A", "B", "B", "C", "C", "D", "D"]);
    });
});

describe("ATS scorer — acceptance", () => {
    it("A1: the strong fixture scores ≥ 80, deterministically, with a 4-key integer rubric", () => {
        const first = scoreResume({ text: STRONG, kind: "text", pages: 1, profile: { skills: [] }, job: null, jobText: null });
        const second = scoreResume({ text: STRONG, kind: "text", pages: 1, profile: { skills: [] }, job: null, jobText: null });
        assert.deepEqual(withoutComputed(first), withoutComputed(second));
        assert.ok(!("computedAt" in first) && !("resume" in first) && !("target" in first));

        assert.ok(first.stats.words >= 350 && first.stats.words <= 900, `fixture has ${first.stats.words} words`);
        assert.equal(first.stats.bullets, 8);
        assert.equal(first.stats.quantifiedBullets, 5);
        assert.equal(first.stats.actionVerbBullets, 6);
        assert.ok(first.score >= 80, `score ${first.score}`);
        assert.equal(first.grade, "A");
        assert.deepEqual(first.stats.sectionsFound, ["summary", "education", "experience", "projects", "skills", "achievements"]);

        const rubric = first.feedback.rubricBreakdown;
        assert.deepEqual(Object.keys(rubric).sort(), ["clarityAndFormatting", "projectDepth", "quantifiedImpact", "skillsMatch"]);
        for (const value of Object.values(rubric)) {
            assert.ok(Number.isInteger(value) && value >= 0 && value <= 100, `rubric value ${value}`);
        }
        assert.ok(Array.isArray(first.feedback.strengths) && first.feedback.strengths.length <= 5);
        assert.ok(Array.isArray(first.feedback.improvements) && first.feedback.improvements.length <= 6);
        for (const item of first.breakdown) {
            assert.ok(["pass", "warn", "fail"].includes(item.status));
            assert.equal(typeof item.detail, "string");
            assert.ok(item.evidence.length <= 5);
            assert.equal(item.points, Math.round(item.points * 10) / 10);
        }
        assert.equal(first.keywords.source, "breadth");
    });

    it("A2: removing the email lowers the score by exactly 4 and asks for an email", () => {
        const base = scoreResume({ text: STRONG });
        const noEmail = scoreResume({ text: STRONG.replace(`${EMAIL} | `, "") });
        assert.equal(base.score - noEmail.score, 4);
        assert.equal(check(base, "contact").status, "pass");
        assert.equal(check(noEmail, "contact").status, "warn");
        assert.ok(noEmail.feedback.improvements.some((text) => /email/i.test(text)), noEmail.feedback.improvements.join(" | "));
    });

    it("A3: quantified-impact points and the quantified-bullet rule", () => {
        const plain = [
            "Built a reporting dashboard for the internal finance team using React and Node.js",
            "Designed a clean onboarding flow that new hires found easier to follow every week",
            "Implemented role-based access control for the admin panel and audit pages",
            "Refactored the legacy billing module into smaller services with clear interfaces",
            "Automated the release checklist so deployments needed fewer manual steps overall",
            "Wrote integration tests for the payments API and fixed the flaky ones in CI",
        ];
        const zero = scoreResume({ text: resumeWithBullets(plain) });
        assert.equal(zero.stats.bullets, 6);
        assert.equal(zero.stats.quantifiedBullets, 0);
        assert.equal(check(zero, "impact").points, 0);

        const half = [
            "Built a reporting dashboard that cut month-end close time by 30% for finance",
            "Designed an onboarding flow used by 450 new hires across three offices",
            "Implemented caching that made the admin panel 3x faster for support staff",
            ...plain.slice(3),
        ];
        const three = scoreResume({ text: resumeWithBullets(half) });
        assert.equal(three.stats.quantifiedBullets, 3);
        assert.equal(check(three, "impact").points, 15);

        assert.equal(isQuantifiedBullet("Reduced latency by 35%"), true);
        assert.equal(isQuantifiedBullet("Served 1,200 daily users"), true);
        assert.equal(isQuantifiedBullet("Served 1,200 users"), true);
        assert.equal(isQuantifiedBullet("Raised ₹50,000 in sponsorships"), true);
        assert.equal(isQuantifiedBullet("Made the build 10× faster"), true);
        assert.equal(isQuantifiedBullet("Handled 5k requests per day"), true);
        assert.equal(isQuantifiedBullet("Cut p95 latency to 120 ms"), true);
        assert.equal(isQuantifiedBullet("Built 3 dashboards"), false);
        assert.equal(isQuantifiedBullet("Automated reports with Python 3"), false);
        assert.equal(isQuantifiedBullet("Led the robotics club 2023 – 2025"), false);
        assert.equal(isQuantifiedBullet("Migrated the service to v12 of the framework"), false);
    });

    it("A4: job keywords — matched react, missing docker and redis, skillsMatch 33", () => {
        const resume = STRONG; // mentions React, never Docker or Redis
        const job = { source: "campus", id: "j1", title: "Backend Developer", company: "Acme", description: "", skills: ["Docker", "Redis", "React"] };
        const result = scoreResume({ text: resume, job, jobText: null, profile: { skills: [] } });
        assert.equal(result.keywords.source, "job");
        assert.deepEqual(result.keywords.matched, ["react"]);
        assert.ok(result.keywords.missing.includes("docker"));
        assert.ok(result.keywords.missing.includes("redis"));
        assert.equal(result.keywords.total, 3);
        assert.equal(result.feedback.rubricBreakdown.skillsMatch, 33);
        assert.match(result.feedback.improvements[0], /docker/i);
        assert.equal(check(result, "keywords").status, "fail");
    });

    it("A5: 'go to market' never adds the keyword go; 'Golang' does", () => {
        const job = { source: "market", id: "m1", title: "Software Engineer", company: "Acme", skills: [] };
        const marketing = scoreResume({ text: STRONG, job, jobText: "You will help our go to market team ship Python tooling for sales analytics." });
        assert.equal(marketing.keywords.source, "job");
        assert.ok(marketing.keywords.matched.concat(marketing.keywords.missing).includes("python"));
        assert.ok(!marketing.keywords.matched.concat(marketing.keywords.missing).includes("go"));

        const golang = scoreResume({ text: STRONG, job, jobText: "We build backend services in Golang and Python on Kubernetes." });
        const terms = golang.keywords.matched.concat(golang.keywords.missing);
        assert.ok(terms.includes("go"));
        assert.ok(golang.keywords.missing.includes("go"));
        assert.ok(golang.keywords.missing.includes("kubernetes"));

        assert.ok(!findSkillTerms("our go to market plan").includes("go"));
        assert.ok(findSkillTerms("services in Golang").includes("go"));
        assert.ok(findSkillTerms("go to market", { extra: ["Go"] }).includes("go"));
        assert.ok(!findSkillTerms("an express delivery").includes("express"));
        assert.ok(findSkillTerms("REST APIs with Express.js").includes("express"));
        assert.ok(!findSkillTerms("C. V. Raman scholarship").includes("c"));
        assert.ok(findSkillTerms("HTML/CSS and CI/CD").includes("html"));
        assert.ok(findSkillTerms("HTML/CSS and CI/CD").includes("ci/cd"));
        assert.ok(findSkillTerms("I know React.").includes("react"));
    });

    it("A7: empty or scanned text scores ≤ 20, fails readability and mentions a scanned PDF", () => {
        for (const text of ["", "Scanned page 1 of 2"]) {
            const result = scoreResume({ text, kind: "pdf", pages: 2 });
            assert.ok(result.score <= 20, `score ${result.score}`);
            assert.equal(check(result, "readability").status, "fail");
            assert.ok(result.feedback.improvements.some((line) => /scanned/i.test(line)), result.feedback.improvements.join(" | "));
            assert.equal(result.grade, "D");
        }
    });

    it("A8: breadth mode without job or profile; profile mode lists missing profile skills", () => {
        const breadth = scoreResume({ text: STRONG, profile: { skills: [] }, job: null });
        assert.equal(breadth.keywords.source, "breadth");
        assert.ok(breadth.keywords.matched.length >= 12);
        assert.deepEqual(breadth.keywords.missing, []);

        const profile = scoreResume({ text: STRONG, profile: { skills: ["Python", "Docker", "Kubernetes"] }, job: null });
        assert.equal(profile.keywords.source, "profile");
        assert.deepEqual(profile.keywords.matched, ["python"]);
        assert.deepEqual(profile.keywords.missing, ["docker", "kubernetes"]);
        assert.equal(profile.keywords.note, undefined);
        assert.ok(profile.feedback.improvements.some((line) => /profile lists Docker and Kubernetes/.test(line)));

        // A job without a description or skills falls back to the profile, with a note.
        const fallback = scoreResume({ text: STRONG, profile: { skills: ["Docker"] }, job: { source: "campus", id: "x", title: "Analyst", skills: [] }, jobText: null });
        assert.equal(fallback.keywords.source, "profile");
        assert.equal(fallback.keywords.note, "This job has no description; scored against your profile skills");
    });
});
