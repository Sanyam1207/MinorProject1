// Pure placements helpers (docs/contracts/PLACEMENTS.md §16 U1–U9): packages, academic years,
// branches, eligibility, skills, offer classification, dates, CSV and the transition table.
import "./helpers.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const { parsePackageLpa, packageLabel, formatLpa } = await import("../src/modules/placements/services/package.js");
const { academicYearFor, academicYearRange, isValidAcademicYear, academicYearMonths } = await import("../src/modules/placements/services/academic-year.js");
const { branchMatches, isUnrestricted, branchLabel } = await import("../src/modules/placements/services/branches.js");
const { evaluateEligibility, studentFacts } = await import("../src/modules/placements/services/eligibility.service.js");
const { skillMatch, canonSkill } = await import("../src/modules/placements/services/skills.js");
const { classifyOffer } = await import("../src/modules/placements/services/policy.service.js");
const { parseDateInput, setClock, resetClock, formatDay, formatDateTime } = await import("../src/utils/dates.js");
const { toCsv, csvCell } = await import("../src/modules/placements/utils/csv.js");
const { canTransition, transitionError, DEFAULT_POLICY } = await import("../src/modules/placements/constants.js");

after(() => resetClock());

describe("U1 parsePackageLpa", () => {
    const vectors = [
        ["18 LPA", 18, 18],
        ["12-15 LPA", 12, 15],
        ["12 to 15 lakhs", 12, 15],
        ["₹18,00,000", 18, 18],
        ["1.2 Cr", 120, 120],
        ["INR 6.5 lakhs", 6.5, 6.5],
        ["50k per month", 6, 6],
        ["25000/month", 3, 3],
        [18, 18, 18],
        [1800000, 18, 18],
        ["not disclosed", null, null],
        ["competitive", null, null],
    ];
    for (const [input, min, max] of vectors) {
        it(`${JSON.stringify(input)} → ${min}/${max}`, () => {
            assert.deepEqual(parsePackageLpa(input), { min, max });
        });
    }
    it("rejects out-of-range values and blanks", () => {
        assert.deepEqual(parsePackageLpa(""), { min: null, max: null });
        assert.deepEqual(parsePackageLpa(null), { min: null, max: null });
        assert.deepEqual(parsePackageLpa(600), { min: null, max: null });
        assert.deepEqual(parsePackageLpa("TBD"), { min: null, max: null });
    });
    it("labels packages", () => {
        assert.equal(packageLabel({ packageLpa: 12, packageMaxLpa: 15 }), "12–15 LPA");
        assert.equal(packageLabel({ packageLpa: 18, packageMaxLpa: 18 }), "18 LPA");
        assert.equal(packageLabel({ packageLpa: null, salary: "Stipend 30k" }), "Stipend 30k");
        assert.equal(packageLabel({ packageLpa: null, salary: "not disclosed" }), "Not disclosed");
        assert.equal(formatLpa(12.5), "12.5");
    });
});

describe("U2 academic years", () => {
    it("switches on 1 July in IST", () => {
        assert.equal(academicYearFor(new Date("2026-06-30T23:59:00+05:30")), "2025-26");
        assert.equal(academicYearFor(new Date("2026-07-01T00:00:00+05:30")), "2026-27");
    });
    it("validates and ranges", () => {
        assert.equal(isValidAcademicYear("2026-27"), true);
        assert.equal(isValidAcademicYear("2026-2027"), false);
        assert.equal(isValidAcademicYear("2026-28"), false);
        assert.equal(isValidAcademicYear("2099-00"), true);
        const range = academicYearRange("2026-27");
        assert.equal(range.start.toISOString(), "2026-06-30T18:30:00.000Z");
        assert.equal(range.end.toISOString(), "2027-06-30T18:30:00.000Z");
        assert.deepEqual(academicYearMonths("2026-27").slice(0, 2), ["2026-07", "2026-08"]);
    });
});

describe("U3 branchMatches (shared canonicalBranch)", () => {
    const yes = [
        ["B.Tech (Computer Science & Engineering)", ["CSE"]],
        ["cse", ["Computer Science"]],
        ["Information Technology", ["IT"]],
        ["Artificial Intelligence and Data Science", ["AIDS"]],
        ["x", ["All branches"]],
        ["Mechatronics", ["mechatronics"]],
    ];
    for (const [student, allowed] of yes) {
        it(`${student} ∈ ${allowed}`, () => assert.equal(branchMatches(student, allowed), true));
    }
    it("Mechanical is not CSE/IT", () => assert.equal(branchMatches("Mechanical Engineering", ["CSE", "IT"]), false));
    it("unrestricted lists and labels", () => {
        assert.equal(isUnrestricted([]), true);
        assert.equal(isUnrestricted(["Open to all"]), true);
        assert.equal(isUnrestricted(["CSE"]), false);
        assert.equal(branchLabel(""), "Unspecified");
        assert.equal(branchLabel("Computer Science"), "CSE");
    });
});

describe("U4 evaluateEligibility", () => {
    const job = { minimumCgpa: 7.5, maximumBacklogs: 0, eligibleBranches: ["CSE", "IT"], graduationYears: ["2026"], packageLpa: 18 };
    const facts = { cgpa: 8.2, activeBacklogs: 0, branch: "CSE", passingYear: "2026", tenthPercentage: 90, twelfthPercentage: 88, verified: false };
    const policy = { ...DEFAULT_POLICY };
    const held = { offerId: "x", companyName: "Infosys", packageLpa: 6 };

    it("all criteria met → eligible", () => {
        const result = evaluateEligibility({ facts, job, policyContext: { policy, held: null } });
        assert.equal(result.status, "eligible");
        assert.equal(result.eligible, true);
        assert.equal(result.code, "ELIGIBLE");
        assert.deepEqual(result.reasons, []);
        assert.equal(result.checks.length, 4);
    });
    it("CGPA below the minimum → NOT_ELIGIBLE with the exact sentence", () => {
        const result = evaluateEligibility({ facts: { ...facts, cgpa: 6.8 }, job, policyContext: { policy, held: null } });
        assert.equal(result.status, "ineligible");
        assert.equal(result.code, "NOT_ELIGIBLE");
        assert.equal(result.reasons[0], "Your CGPA of 6.80 is below the required minimum of 7.50.");
        assert.deepEqual(result.checks.find((check) => check.key === "cgpa"), { key: "cgpa", label: "Minimum CGPA", required: ">= 7.50", actual: "6.80", passed: false });
    });
    it("backlogs unknown → incomplete with missing activeBacklogs", () => {
        const result = evaluateEligibility({ facts: { ...facts, activeBacklogs: null }, job, policyContext: { policy, held: null } });
        assert.equal(result.status, "incomplete");
        assert.equal(result.code, "PROFILE_INCOMPLETE");
        assert.deepEqual(result.missing, ["activeBacklogs"]);
        assert.equal(result.reasons[0], "Add your active backlogs to your profile to check eligibility.");
    });
    it("joins several missing labels", () => {
        const result = evaluateEligibility({ facts: { ...facts, cgpa: null, activeBacklogs: null }, job, policyContext: null });
        assert.equal(result.reasons[0], "Add your CGPA and active backlogs to your profile to check eligibility.");
    });
    it("a failed check beats a missing value", () => {
        const result = evaluateEligibility({ facts: { ...facts, cgpa: 6, activeBacklogs: null }, job, policyContext: null });
        assert.equal(result.status, "ineligible");
        assert.deepEqual(result.missing, ["activeBacklogs"]);
    });
    it("graduation year mismatch, branch, backlogs and percentages use the exact templates", () => {
        const result = evaluateEligibility({
            facts: { ...facts, passingYear: "2027", branch: "Mechanical Engineering", activeBacklogs: 2, twelfthPercentage: 72 },
            job: { ...job, min12thPercentage: 75 },
            policyContext: null,
        });
        assert.equal(result.status, "ineligible");
        assert.deepEqual(result.reasons, [
            "You have 2 active backlog(s); at most 0 allowed.",
            "Your branch (Mechanical Engineering) is not among the eligible branches: CSE, IT.",
            "This drive is open to 2026 graduates; your passing year is 2027.",
            "Your 12th percentage (72%) is below the 75% cut-off.",
        ]);
    });
    it("held 6 LPA, multiplier 1.5, drive 8 → POLICY_BLOCKED", () => {
        const result = evaluateEligibility({ facts, job: { ...job, packageLpa: 8 }, policyContext: { policy, held } });
        assert.equal(result.code, "POLICY_BLOCKED");
        assert.equal(result.status, "ineligible");
        assert.equal(result.policy.requiredPackageLpa, 9);
        assert.equal(result.policy.currentAcceptedPackage, 6);
        assert.equal(result.reasons[0], "One-offer policy: you have already accepted Infosys (6 LPA). Only drives offering at least 9 LPA are open to you.");
    });
    it("held 6 LPA, drive 9 → eligible dream upgrade", () => {
        const result = evaluateEligibility({ facts, job: { ...job, packageLpa: 9 }, policyContext: { policy, held } });
        assert.equal(result.status, "eligible");
        assert.equal(result.policy.isDreamUpgrade, true);
    });
    it("dream upgrades off → blocked", () => {
        const result = evaluateEligibility({ facts, job: { ...job, packageLpa: 50 }, policyContext: { policy: { ...policy, allowDreamUpgrade: false }, held } });
        assert.equal(result.code, "POLICY_BLOCKED");
        assert.equal(result.reasons[0], "One-offer policy: you have already accepted Infosys (6 LPA), so you cannot apply to new drives.");
    });
    it("undisclosed package → blocked", () => {
        const result = evaluateEligibility({ facts, job: { ...job, packageLpa: null }, policyContext: { policy, held } });
        assert.equal(result.code, "POLICY_BLOCKED");
        assert.match(result.reasons[0], /package is not disclosed/);
    });
    it("enforceOneOffer:false → eligible", () => {
        const result = evaluateEligibility({ facts, job: { ...job, packageLpa: 7 }, policyContext: { policy: { ...policy, enforceOneOffer: false }, held } });
        assert.equal(result.status, "eligible");
        assert.equal(result.policy.enforced, false);
    });
    it("studentFacts reads only stored fields", () => {
        assert.deepEqual(studentFacts({ cgpa: "8.1", activeBacklogs: 0, branch: " CSE ", passingYear: 2026, ggsipuLinked: true }), {
            cgpa: 8.1, activeBacklogs: 0, branch: "CSE", passingYear: "2026", tenthPercentage: null, twelfthPercentage: null, verified: true,
        });
    });
});

describe("U5 skillMatch", () => {
    it("matches canonical skills", () => {
        assert.deepEqual(skillMatch(["React.js", "Node"], ["react", "nodejs", "SQL"]), {
            matchPercentage: 67, matchedSkills: ["react", "nodejs"], missingSkills: ["SQL"],
        });
        assert.equal(canonSkill("C++"), "c++");
        assert.deepEqual(skillMatch(["x"], []), { matchPercentage: null, matchedSkills: [], missingSkills: [] });
    });
});

describe("U6 classifyOffer", () => {
    it("normal / dream / super-dream relative to the held package", () => {
        assert.equal(classifyOffer(12, 10, DEFAULT_POLICY), "normal");
        assert.equal(classifyOffer(15, 10, DEFAULT_POLICY), "dream");
        assert.equal(classifyOffer(20, 10, DEFAULT_POLICY), "super-dream");
        assert.equal(classifyOffer(50, null, DEFAULT_POLICY), "normal");
    });
});

describe("U7 parseDateInput", () => {
    it("YYYY-MM-DD with endOfDay is the end of that IST day", () => {
        assert.equal(parseDateInput("2026-12-05", { endOfDay: true }).toISOString(), "2026-12-05T18:29:59.999Z");
        assert.equal(parseDateInput("2026-12-05").toISOString(), "2026-12-04T18:30:00.000Z");
    });
    it("ISO instants pass through", () => {
        assert.equal(parseDateInput("2026-12-05T10:00:00.000Z").toISOString(), "2026-12-05T10:00:00.000Z");
    });
    it("natural language against a fixed clock", () => {
        setClock(() => new Date("2026-11-25T06:30:00.000Z")); // Wednesday 25 Nov 2026, 12:00 IST
        try {
            const friday = parseDateInput("next friday", { endOfDay: true });
            assert.equal(formatDateTime(friday).endsWith("23:59"), true);
            assert.equal(new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Asia/Kolkata" }).format(friday), "Friday");
            assert.ok(friday > new Date("2026-11-25T06:30:00.000Z"));
            assert.equal(parseDateInput("tomorrow 10am").toISOString(), "2026-11-26T04:30:00.000Z");
            assert.equal(formatDay(parseDateInput("5 Dec")), "5 Dec");
        } finally {
            resetClock();
        }
    });
    it("garbage → 400 VALIDATION with the field", () => {
        assert.throws(() => parseDateInput("purple monkey", { field: "deadline" }), (error) => {
            assert.equal(error.statusCode, 400);
            assert.deepEqual(error.errors[0], { code: "VALIDATION", field: "deadline" });
            return true;
        });
    });
});

describe("U8 toCsv", () => {
    it("quotes, doubles quotes, guards formulas and starts with a BOM", () => {
        const csv = toCsv([{ header: "Name", value: (row) => row.name }, { header: "Note", value: (row) => row.note }], [
            { name: "Doe, Jane", note: 'Said "hi"' },
            { name: "=SUM(A1)", note: "-1" },
        ]);
        assert.equal(csv.charCodeAt(0), 0xFEFF);
        const lines = csv.slice(1).split("\r\n");
        assert.deepEqual(lines, ["Name,Note", '"Doe, Jane","Said ""hi"""', "'=SUM(A1),'-1"]);
        assert.equal(csvCell("@cmd"), "'@cmd");
        assert.equal(csvCell(null), "");
    });
});

describe("U9 application transition table", () => {
    const staff = ["applied", "shortlisted", "interview", "rejected"];
    it("allows every staff pair between live statuses", () => {
        for (const from of ["applied", "shortlisted", "interview"]) {
            for (const to of staff) assert.equal(canTransition(from, to, "tpo"), true, `${from}→${to}`);
            for (const to of staff) assert.equal(canTransition(from, to, "company"), true, `${from}→${to} (company)`);
        }
    });
    it("only the placement office reopens rejected applications", () => {
        for (const to of ["applied", "shortlisted", "interview"]) {
            assert.equal(canTransition("rejected", to, "tpo"), true);
            assert.equal(canTransition("rejected", to, "admin"), true);
            assert.equal(transitionError("rejected", to, "company").errors[0].code, "INVALID_TRANSITION");
        }
    });
    it("offered/hired go through the offer flow; withdrawn is final", () => {
        for (const to of ["offered", "hired"]) assert.equal(transitionError("applied", to, "tpo").errors[0].code, "USE_OFFER_FLOW");
        for (const from of ["offered", "hired"]) assert.equal(transitionError(from, "rejected", "tpo").errors[0].code, "USE_OFFER_FLOW");
        assert.equal(transitionError("withdrawn", "shortlisted", "tpo").errors[0].code, "INVALID_TRANSITION");
        assert.equal(transitionError("applied", "withdrawn", "tpo").errors[0].code, "VALIDATION");
        assert.equal(transitionError("applied", "applied", "tpo"), null);
    });
});
