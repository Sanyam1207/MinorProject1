// Deterministic, explainable ATS scorer (docs/contracts/RESUME-BYOK.md §5).
//
//   scoreResume({text, kind, pages, profile: {skills}, job, jobText}) → ScoreResult (without resume/target/computedAt)
//
// Pure: no I/O, no clock, no randomness — the same input always yields a deep-equal result.
// The caller (resume.service.js#scoreResumeById) adds `resume`, `target` and `computedAt`.
import {
    analyzeText,
    canonicalizeSkill,
    findLexiconTerms,
    findSkillTerms,
    hasFirstPerson,
    hasWeakPhrase,
    isQuantifiedBullet,
    matchesSkill,
    prepareMatchText,
    startsWithActionVerb,
} from "./text.js";

export { canonicalizeSkill, findSkillTerms };

export const SCORER_VERSION = "ats-v1";

const STRENGTH_ORDER = ["keywords", "sections", "impact", "contact", "action_verbs", "length", "readability", "depth"];
const MAX_STRENGTHS = 5;
const MAX_IMPROVEMENTS = 6;
const MAX_EVIDENCE = 5;
const MAX_PROFILE_SKILLS = 30;
const BREADTH_TARGET = 12;

const SECTION_LABELS = {
    summary: "Summary",
    education: "Education",
    experience: "Experience",
    projects: "Projects",
    skills: "Skills",
    achievements: "Achievements",
};

export const gradeFor = (score) => (score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D");

const percentOf = (points, weight) => Math.round((points / weight) * 100);
const oneDecimal = (value) => Math.round(value * 10) / 10;
const clip = (value, max = 120) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const listText = (items) => {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// ── Contact ──────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_CANDIDATE_RE = /(?:\+\s?\d{1,3}[\s-]*)?\(?\d[\d\s()-]{7,}\d/g;
const YEAR_GROUP_RE = /^(?:19[5-9]\d|20[0-3]\d)$/;

const hasPhone = (text) => {
    for (const match of text.matchAll(PHONE_CANDIDATE_RE)) {
        const candidate = match[0];
        const digits = candidate.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) continue;
        const groups = candidate.split(/[^\d]+/).filter(Boolean);
        if (groups.every((group) => YEAR_GROUP_RE.test(group))) continue; // "2021 - 2023 2024 - 2025"
        return true;
    }
    return false;
};

const hasOtherLink = (text) => {
    if (/(?:github|gitlab)\.com\//i.test(text)) return true;
    for (const match of text.matchAll(/https?:\/\/[^\s|,;)]+/gi)) {
        if (!/linkedin\.com/i.test(match[0])) return true;
    }
    return false;
};

// ── Checks ───────────────────────────────────────────────────────────────────

const sectionsCheck = (analysis) => {
    const found = new Set(analysis.sectionsFound);
    const hasEducation = found.has("education");
    const hasSkills = found.has("skills");
    const hasWork = found.has("experience") || found.has("projects");
    const points = (hasEducation ? 4 : 0) + (hasSkills ? 4 : 0) + (hasWork ? 4 : 0)
        + (found.has("achievements") ? 1.5 : 0) + (found.has("summary") ? 1.5 : 0);
    const required = [hasEducation, hasSkills, hasWork].filter(Boolean).length;
    const missing = [
        !hasEducation && "Education",
        !hasSkills && "Skills",
        !hasWork && "Experience or Projects",
    ].filter(Boolean);
    const foundLabels = analysis.sectionsFound.map((id) => SECTION_LABELS[id]);
    const detail = foundLabels.length
        ? `Found ${listText(foundLabels)}${missing.length ? `; missing ${listText(missing)}` : ""}`
        : "No standard section headings found";
    return {
        id: "sections",
        label: "Standard sections",
        weight: 15,
        points,
        status: required === 3 ? "pass" : required === 2 ? "warn" : "fail",
        detail,
        suggestion: `Add clear section headings for ${listText(missing.length ? missing : ["Summary", "Achievements"])}.`,
        strength: `Has the standard ATS sections: ${listText(foundLabels)}`,
        evidence: foundLabels.slice(0, MAX_EVIDENCE),
    };
};

const contactCheck = (text) => {
    const email = EMAIL_RE.test(text);
    const phone = hasPhone(text);
    const linkedin = /linkedin\.com\/in\//i.test(text);
    const other = hasOtherLink(text);
    const points = (email ? 4 : 0) + (phone ? 3 : 0) + (linkedin ? 1.5 : 0) + (other ? 1.5 : 0);
    const items = [
        { ok: email, name: "email", add: "an email address" },
        { ok: phone, name: "phone", add: "a phone number" },
        { ok: linkedin, name: "LinkedIn", add: "your LinkedIn URL" },
        { ok: other, name: "GitHub/portfolio link", add: "a GitHub or portfolio link" },
    ];
    const present = items.filter((item) => item.ok).map((item) => item.name);
    const absent = items.filter((item) => !item.ok);
    return {
        id: "contact",
        label: "Contact details",
        weight: 10,
        points,
        status: email && phone ? "pass" : email || phone ? "warn" : "fail",
        detail: present.length
            ? `Found ${listText(present)}${absent.length ? `; missing ${listText(absent.map((item) => item.name))}` : ""}`
            : "No contact details found",
        suggestion: absent.length ? `Add ${listText(absent.map((item) => item.add))}.` : null,
        strength: "Complete contact details",
        evidence: [],
    };
};

const keywordsCheck = ({ resumePrepared, job, jobText, profile }) => {
    const display = new Map();
    const canonicalList = (list) => {
        const out = [];
        for (const raw of Array.isArray(list) ? list : []) {
            if (typeof raw !== "string") continue;
            const canonical = canonicalizeSkill(raw);
            if (!canonical || out.includes(canonical)) continue;
            out.push(canonical);
            if (!display.has(canonical)) display.set(canonical, raw.trim().replace(/\s+/g, " "));
        }
        return out;
    };
    const jobSkills = job ? canonicalList(job.skills) : [];
    const profileSkillsAll = canonicalList(profile?.skills);
    const profileSkills = profileSkillsAll.slice(0, MAX_PROFILE_SKILLS);
    const explicit = new Set([...jobSkills, ...profileSkillsAll]);
    const label = (canonical) => display.get(canonical) || canonical;

    let source;
    let terms;
    let note;
    if (job) {
        terms = [...jobSkills];
        const jobPrepared = prepareMatchText(`${typeof job.title === "string" ? job.title : ""}\n${typeof jobText === "string" ? jobText : ""}`);
        for (const term of findLexiconTerms(jobPrepared, explicit)) if (!terms.includes(term)) terms.push(term);
    }
    if (terms?.length) {
        source = "job";
    } else if (profileSkills.length) {
        source = "profile";
        terms = profileSkills;
        if (job) note = "This job has no description; scored against your profile skills";
    } else {
        source = "breadth";
    }

    const jobTitle = typeof job?.title === "string" && job.title.trim() ? job.title.trim() : "this job";
    const base = { id: "keywords", label: "Keyword match", weight: 25, evidence: [] };

    if (source === "breadth") {
        const found = findLexiconTerms(resumePrepared, explicit);
        const points = 25 * Math.min(found.length, BREADTH_TARGET) / BREADTH_TARGET;
        const percent = percentOf(points, 25);
        return {
            ...base,
            points,
            status: percent >= 70 ? "pass" : percent >= 40 ? "warn" : "fail",
            detail: found.length ? `Lists ${plural(found.length, "recognised technical skill")}` : "No recognised technical skills found",
            suggestion: "Add a Skills section listing the tools and languages you actually use.",
            strength: `Lists ${found.length} recognised technical skills`,
            evidence: found.slice(0, MAX_EVIDENCE),
            keywords: { source, total: found.length, matched: found, missing: [] },
        };
    }

    const matched = terms.filter((term) => matchesSkill(resumePrepared, term, explicit));
    const missing = terms.filter((term) => !matched.includes(term));
    const points = 25 * matched.length / terms.length;
    const percent = percentOf(points, 25);
    const missingText = listText(missing.slice(0, 5).map(label));
    const keywords = { source, total: terms.length, matched, missing };
    if (note) keywords.note = note;
    return {
        ...base,
        points,
        status: percent >= 70 ? "pass" : percent >= 40 ? "warn" : "fail",
        detail: source === "job"
            ? `Matches ${matched.length} of ${terms.length} key skills for ${jobTitle}`
            : `Mentions ${matched.length} of ${terms.length} skills from your profile`,
        suggestion: source === "job"
            ? `Mention ${missingText} if you have used them — they appear in this job's requirements.`
            : `Your profile lists ${missingText} but the resume doesn't mention them.`,
        strength: source === "job"
            ? `Covers ${matched.length} of ${terms.length} key skills for ${jobTitle}`
            : `Shows ${matched.length} of ${terms.length} skills from your profile`,
        evidence: matched.slice(0, MAX_EVIDENCE).map(label),
        keywords,
    };
};

const impactCheck = (bullets, quantified) => {
    const total = bullets.length;
    const count = quantified.filter(Boolean).length;
    const ratio = total ? count / total : 0;
    return {
        id: "impact",
        label: "Quantified impact",
        weight: 15,
        points: total === 0 ? 0 : 15 * Math.min(ratio / 0.5, 1),
        status: total && ratio >= 0.4 ? "pass" : total && ratio >= 0.2 ? "warn" : "fail",
        detail: total ? `${count} of ${total} bullets show measurable results` : "No bullet points found",
        suggestion: total
            ? `Add numbers to more bullets — only ${count} of ${total} show measurable results (aim for at least half).`
            : "Write experience and projects as bullet points with measurable results.",
        strength: `${count} of ${total} bullets show measurable results`,
        evidence: bullets.filter((_, index) => !quantified[index]).slice(0, MAX_EVIDENCE).map((bullet) => clip(bullet.text)),
    };
};

const actionVerbsCheck = (bullets, verbFlags, weakFlags) => {
    const total = bullets.length;
    const strong = verbFlags.filter(Boolean).length;
    const weak = weakFlags.filter(Boolean).length;
    const ratio = total ? strong / total : 0;
    const points = total === 0 ? 0 : Math.max(0, 10 * Math.min(ratio / 0.6, 1) - Math.min(3, 0.5 * weak));
    const evidence = [
        ...bullets.filter((_, index) => weakFlags[index]),
        ...bullets.filter((_, index) => !weakFlags[index] && !verbFlags[index]),
    ].slice(0, MAX_EVIDENCE).map((bullet) => clip(bullet.text));
    return {
        id: "action_verbs",
        label: "Action verbs",
        weight: 10,
        points,
        status: total && ratio >= 0.6 && weak === 0 ? "pass" : total && ratio >= 0.3 ? "warn" : "fail",
        detail: total
            ? `${strong} of ${total} bullets start with a strong action verb${weak ? `; ${plural(weak, "bullet")} use weak phrasing` : ""}`
            : "No bullet points found",
        suggestion: total
            ? `Start bullets with strong verbs (built, designed, led…) — ${strong} of ${total} do now.${weak > 0 ? ` Avoid 'helped/worked on' (${plural(weak, "bullet")}).` : ""}`
            : "Write experience and projects as bullet points that start with strong verbs (built, designed, led…).",
        strength: `${strong} of ${total} bullets start with strong action verbs`,
        evidence,
    };
};

const lengthCheck = (words, pages) => {
    let points;
    if (words >= 350 && words <= 900) points = 10;
    else if ((words >= 250 && words < 350) || (words > 900 && words <= 1100)) points = 7;
    else if ((words >= 150 && words < 250) || (words > 1100 && words <= 1400)) points = 4;
    else points = 1;
    const tooManyPages = pages !== null && pages > 2;
    if (tooManyPages) points = Math.max(0, points - 3);
    const short = words < 350;
    return {
        id: "length",
        label: "Length",
        weight: 10,
        points,
        status: points >= 10 ? "pass" : points >= 4 ? "warn" : "fail",
        detail: `${plural(words, "word")}${pages !== null ? `, ${plural(pages, "page")}` : ""}`,
        suggestion: short && !tooManyPages
            ? `Your resume is short (${words} words) — add detail to projects and experience.`
            : `Trim to the most relevant content (${words} words; aim for 350–900 and at most 2 pages).`,
        strength: `Good length (${words} words)`,
        evidence: [],
    };
};

const BAD_CHAR_RE = /[�-\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const readabilityCheck = (text, bullets) => {
    const firstPerson = bullets.filter((bullet) => hasFirstPerson(bullet.text));
    const noFirstPerson = firstPerson.length <= 1;
    const wellSized = bullets.filter((bullet) => bullet.words >= 8 && bullet.words <= 35).length;
    const sizePoints = bullets.length ? Math.min(3, 3 * (wellSized / bullets.length) / 0.7) : 0;
    const hasYear = /\b(19|20)\d{2}\b/.test(text);
    const badChars = (text.match(BAD_CHAR_RE) || []).length;
    const readable = text.length >= 300 && badChars / text.length <= 0.02;
    const points = (noFirstPerson ? 3 : 0) + sizePoints + (hasYear ? 2 : 0) + (readable ? 2 : 0);

    // "Pick the failing sub-check": almost no text (the §4 no-selectable-text threshold) or garbled
    // characters mean the file itself is unreadable, which explains every other failure, so it wins
    // and is listed first among the improvements. A merely short text resume gets the other advice first.
    const SCANNED = "ATS systems can't read this file's text (scanned or image-based PDF?) — upload a text-based PDF or DOCX.";
    const unreadable = text.trim().length < 200 || (text.length > 0 && badChars / text.length > 0.02);
    let suggestion;
    if (unreadable) suggestion = SCANNED;
    else if (!noFirstPerson) suggestion = "Avoid 'I/my' in bullets.";
    else if (sizePoints < 3) suggestion = "Keep bullets between 8 and 35 words.";
    else if (!hasYear) suggestion = "Add dates (month/year) to education and experience.";
    else suggestion = SCANNED;

    const notes = [
        readable ? "text is machine-readable" : "text is missing or unreadable",
        bullets.length ? `${wellSized} of ${bullets.length} bullets are 8–35 words` : "no bullets",
        hasYear ? "dates found" : "no dates found",
    ];
    if (!noFirstPerson) notes.push(`${plural(firstPerson.length, "bullet")} use I/my`);
    const detail = notes.join("; ");
    return {
        id: "readability",
        label: "ATS readability",
        weight: 10,
        points,
        status: points >= 8 ? "pass" : points >= 5 ? "warn" : "fail",
        detail: detail.charAt(0).toUpperCase() + detail.slice(1),
        suggestion,
        strength: "Clean, ATS-readable text",
        evidence: firstPerson.slice(0, MAX_EVIDENCE).map((bullet) => clip(bullet.text)),
        unreadable,
    };
};

const depthCheck = (bullets, sectionsFound) => {
    const total = bullets.length;
    const hasWork = sectionsFound.includes("experience") || sectionsFound.includes("projects");
    const points = 5 * (Math.min(total, 6) / 6) * (hasWork ? 1 : 0.5);
    return {
        id: "depth",
        label: "Project/experience depth",
        weight: 5,
        points,
        status: points >= 5 ? "pass" : points >= 2.5 ? "warn" : "fail",
        detail: `${plural(total, "bullet point")}${hasWork ? "" : "; no Experience or Projects section"}`,
        suggestion: "Add more detail to projects and experience — aim for at least 6 bullet points.",
        strength: `Enough project and experience detail (${total} bullet points)`,
        evidence: [],
    };
};

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Score resume text deterministically.
 * @param {{text?: string, kind?: string|null, pages?: number|null, profile?: {skills?: string[]},
 *          job?: {source?, id?, title?, company?, description?, skills?: string[]}|null, jobText?: string|null}} input
 */
export const scoreResume = ({ text = "", kind = null, pages = null, profile = {}, job = null, jobText = null } = {}) => {
    void kind; // accepted for API symmetry; the score depends only on the text
    const source = typeof text === "string" ? text : "";
    const pageCount = pages === null || pages === undefined || !Number.isFinite(Number(pages)) ? null : Number(pages);
    const analysis = analyzeText(source);
    const { bullets } = analysis;

    const quantified = bullets.map((bullet) => isQuantifiedBullet(bullet.text));
    const verbFlags = bullets.map((bullet) => startsWithActionVerb(bullet.text));
    const weakFlags = bullets.map((bullet) => hasWeakPhrase(bullet.text));

    const keywords = keywordsCheck({ resumePrepared: prepareMatchText(source), job: job || null, jobText, profile });
    const checks = [
        sectionsCheck(analysis),
        contactCheck(source),
        keywords,
        impactCheck(bullets, quantified),
        actionVerbsCheck(bullets, verbFlags, weakFlags),
        lengthCheck(analysis.words, pageCount),
        readabilityCheck(source, bullets),
        depthCheck(bullets, analysis.sectionsFound),
    ];
    for (const check of checks) check.percent = percentOf(check.points, check.weight);

    const total = checks.reduce((sum, check) => sum + check.points, 0);
    const score = Math.round(total);
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));

    const strengths = STRENGTH_ORDER
        .map((id) => byId[id])
        .filter((check) => check.percent >= 80)
        .slice(0, MAX_STRENGTHS)
        .map((check) => check.strength);

    // Sorted by lost points; unreadable text is the root cause of every other failure, so it leads.
    const improvements = checks
        .map((check, order) => ({ check, order }))
        .filter(({ check }) => check.percent < 80 && check.suggestion)
        .sort((a, b) => (Number(Boolean(b.check.unreadable)) - Number(Boolean(a.check.unreadable)))
            || ((b.check.weight - b.check.points) - (a.check.weight - a.check.points))
            || (a.order - b.order))
        .slice(0, MAX_IMPROVEMENTS)
        .map(({ check }) => check.suggestion);

    const points = (id) => byId[id].points;
    const rubricBreakdown = {
        skillsMatch: byId.keywords.percent,
        projectDepth: Math.round(((points("depth") + points("action_verbs")) / 15) * 100),
        quantifiedImpact: byId.impact.percent,
        clarityAndFormatting: Math.round(((points("sections") + points("contact") + points("length") + points("readability")) / 45) * 100),
    };

    return {
        score,
        feedback: { rubricBreakdown, strengths, improvements },
        grade: gradeFor(score),
        breakdown: checks.map((check) => ({
            id: check.id,
            label: check.label,
            weight: check.weight,
            points: oneDecimal(check.points),
            percent: check.percent,
            status: check.status,
            detail: check.detail,
            suggestion: check.percent < 80 ? check.suggestion : null,
            evidence: check.evidence.slice(0, MAX_EVIDENCE),
        })),
        keywords: keywords.keywords,
        stats: {
            words: analysis.words,
            bullets: bullets.length,
            quantifiedBullets: quantified.filter(Boolean).length,
            actionVerbBullets: verbFlags.filter(Boolean).length,
            weakPhraseBullets: weakFlags.filter(Boolean).length,
            pages: pageCount,
            sectionsFound: analysis.sectionsFound,
        },
        scorerVersion: SCORER_VERSION,
    };
};
