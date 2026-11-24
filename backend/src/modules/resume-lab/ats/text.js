// Text analysis for the deterministic ATS scorer (docs/contracts/RESUME-BYOK.md §5.1).
// Pure functions only: no I/O, no clock, no randomness.
import { ACTION_VERBS, AMBIGUOUS_TERMS, SECTION_SYNONYMS, SKILL_TERMS, WEAK_PHRASES } from "./lexicon.js";

export const SECTION_IDS = Object.freeze(["summary", "education", "experience", "projects", "skills", "achievements"]);
const FALLBACK_BULLET_SECTIONS = new Set(["experience", "projects", "achievements"]);

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9+#.'\/-]*/g;
// A bullet glyph (or an icon-font private-use glyph) followed by text.
const BULLET_RE = /^(?:[•●▪◦‣∙·*\-–]|[-])+\s*(.*)$/u;
const WEAK_RE = new RegExp(`\\b(?:${WEAK_PHRASES.map((phrase) => phrase.replace(/\s+/g, "\\s+")).join("|")})\\b`, "i");

/** Number of words (§5.1 word regex). */
export const countWords = (value) => (String(value ?? "").match(WORD_RE) || []).length;

const collapse = (value) => value.replace(/\s+/g, " ").trim();

// ── Headings ─────────────────────────────────────────────────────────────────

const EXACT_HEADINGS = new Map();
const PREFIX_HEADINGS = [];
for (const [section, synonyms] of Object.entries(SECTION_SYNONYMS)) {
    for (const synonym of synonyms) {
        if (!EXACT_HEADINGS.has(synonym)) EXACT_HEADINGS.set(synonym, section);
        if (synonym.length >= 6) PREFIX_HEADINGS.push({ synonym, section });
    }
}
// Longest synonym first, so "work experience …" wins over a shorter prefix.
PREFIX_HEADINGS.sort((a, b) => b.synonym.length - a.synonym.length);

/** The section id a line introduces, or null when it is not a heading. */
export const detectHeading = (line) => {
    const stripped = collapse(String(line ?? "").replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, ""));
    if (!stripped || stripped.length > 40 || stripped.split(" ").length > 5) return null;
    const lower = stripped.toLowerCase();
    if (EXACT_HEADINGS.has(lower)) return EXACT_HEADINGS.get(lower);
    for (const { synonym, section } of PREFIX_HEADINGS) {
        if (lower.startsWith(`${synonym} `)) return section;
    }
    return null;
};

// ── Bullets ──────────────────────────────────────────────────────────────────

const bulletText = (line) => {
    const match = BULLET_RE.exec(line);
    if (!match) return null;
    const rest = match[1].trim();
    return /[A-Za-z0-9]/.test(rest) ? rest : null;
};

/**
 * Split text into lines, headings, sections and bullets.
 * @returns {{text, lines: string[], entries: object[], sectionsFound: string[], bullets: {text: string, words: number, section: string|null}[], words: number}}
 */
export const analyzeText = (text) => {
    const raw = typeof text === "string" ? text : "";
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const entries = [];
    const found = new Set();
    let current = null;
    lines.forEach((line, index) => {
        const glyphText = bulletText(line);
        const heading = glyphText === null ? detectHeading(line) : null;
        if (heading) {
            current = heading;
            found.add(heading);
        }
        entries.push({ index, line, heading, section: heading || current, glyphText });
    });

    const glyphBullets = entries.filter((entry) => entry.glyphText !== null);
    let bulletEntries = glyphBullets;
    if (glyphBullets.length < 3) {
        // Fallback (§5.1): substantial lines inside experience / projects / achievements.
        const chosen = new Set(glyphBullets.map((entry) => entry.index));
        for (const entry of entries) {
            if (entry.heading || !FALLBACK_BULLET_SECTIONS.has(entry.section)) continue;
            const words = countWords(entry.glyphText ?? entry.line);
            if (words >= 6 && words <= 60) chosen.add(entry.index);
        }
        bulletEntries = entries.filter((entry) => chosen.has(entry.index));
    }

    const bullets = bulletEntries.map((entry) => {
        const value = entry.glyphText ?? entry.line;
        return { text: value, words: countWords(value), section: entry.section };
    });

    return {
        text: raw,
        lines,
        entries,
        sectionsFound: SECTION_IDS.filter((id) => found.has(id)),
        bullets,
        words: countWords(raw),
    };
};

// ── Bullet qualities ─────────────────────────────────────────────────────────

const PERCENT_RE = /\d\s*%|\d\s*percent\b/i;
const MULTIPLIER_RE = /(?<![A-Za-z0-9.])\d+(?:\.\d+)?\s?[x×](?![A-Za-z0-9])/i;
const CURRENCY_RE = /[₹$€£]\s?\d/;
const MAGNITUDE_RE = /(?<![A-Za-z0-9])\d+(?:[.,]\d+)*\s?(?:[kK]|M|L|Cr|lakhs?|crores?)(?![A-Za-z])/;
const UNIT_RE = /(?<![A-Za-z0-9])\d+(?:\.\d+)?\s?(?:ms|secs?|s|mins?|hrs?|gb|mb|tb|req\/s|rps|qps)(?![A-Za-z])/i;
const NUMBER_RE = /(?<![0-9.,])\d+(?:,\d{3})*(?:\.\d+)?/g;

const hasSignificantInteger = (value) => {
    for (const match of value.matchAll(NUMBER_RE)) {
        const previous = match.index > 0 ? value[match.index - 1] : "";
        if (/[A-Za-z]/.test(previous)) continue; // "v10", "CS101"
        const token = match[0];
        const integerPart = token.split(".")[0];
        const integer = Number(integerPart.replace(/,/g, ""));
        if (!Number.isFinite(integer) || integer < 10) continue;
        const isYear = /^\d{4}$/.test(integerPart) && !token.includes(".") && integer >= 1950 && integer <= 2039;
        if (isYear) continue;
        return true;
    }
    return false;
};

/** §5.1 quantified bullet: a percentage, multiplier, currency, magnitude, unit or a meaningful integer. */
export const isQuantifiedBullet = (value) => {
    const text = String(value ?? "");
    return PERCENT_RE.test(text)
        || MULTIPLIER_RE.test(text)
        || CURRENCY_RE.test(text)
        || MAGNITUDE_RE.test(text)
        || UNIT_RE.test(text)
        || hasSignificantInteger(text);
};

/** Lowercase first word of a bullet. */
export const firstWord = (value) => {
    const match = /[A-Za-z][A-Za-z'-]*/.exec(String(value ?? ""));
    return match ? match[0].toLowerCase() : "";
};

export const startsWithActionVerb = (value) => ACTION_VERBS.has(firstWord(value));
export const hasWeakPhrase = (value) => WEAK_RE.test(String(value ?? ""));
export const hasFirstPerson = (value) => /\bI\b/.test(value) || /\b(?:me|my|myself)\b/i.test(value);

// ── Skill matching ───────────────────────────────────────────────────────────

/**
 * §5.1 matching normalisation: lowercase, characters outside [a-z0-9+#./] → spaces, padded.
 * Also drops sentence-final dots ("React." → "react") and collapses whitespace so
 * multi-word aliases match; dots inside tokens ("node.js", ".net") are kept.
 */
export const normalizeForMatch = (value) => {
    const cleaned = String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9+#./]+/g, " ")
        .replace(/\.+(?=\s|$)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return ` ${cleaned} `;
};

const normalizeTerm = (value) => normalizeForMatch(value).trim();

const SKILL_INDEX = Object.entries(SKILL_TERMS).map(([canonical, aliases]) => {
    const canonicalNorm = normalizeTerm(canonical);
    const aliasNorms = [...new Set(aliases.map(normalizeTerm).filter((alias) => alias && alias !== canonicalNorm))];
    const all = [canonicalNorm, ...aliasNorms];
    return Object.freeze({ canonical, all, safe: AMBIGUOUS_TERMS.has(canonical) ? aliasNorms : all });
});
const BY_CANONICAL = new Map(SKILL_INDEX.map((entry) => [entry.canonical, entry]));
const LOOKUP = new Map();
for (const entry of SKILL_INDEX) {
    for (const name of entry.all) if (!LOOKUP.has(name)) LOOKUP.set(name, entry.canonical);
}

export const isLexiconSkill = (canonical) => BY_CANONICAL.has(canonical);

/** Canonical lowercase name of a skill: the lexicon term it names, else its normalised phrase ("" when empty). */
export const canonicalizeSkill = (name) => {
    if (typeof name !== "string") return "";
    const normalized = normalizeTerm(name);
    if (!normalized) return "";
    return LOOKUP.get(normalized) ?? normalized;
};

/** Prepare text once for repeated term lookups ("/" also splits words: "HTML/CSS"). */
export const prepareMatchText = (text) => {
    const primary = normalizeForMatch(text);
    const split = primary.includes("/") ? primary.replace(/\//g, " ").replace(/ {2,}/g, " ") : primary;
    return { primary, split };
};

const hasPhrase = (prepared, phrase) => {
    const needle = ` ${phrase} `;
    return prepared.primary.includes(needle) || prepared.split.includes(needle);
};

/**
 * Whether `canonical` occurs in the prepared text. Ambiguous lexicon terms match only through
 * their unambiguous aliases unless `explicit` (a Set of canonical names) contains them.
 * Unknown skills match as a normalised phrase.
 */
export const matchesSkill = (prepared, canonical, explicit = new Set()) => {
    const entry = BY_CANONICAL.get(canonical);
    if (!entry) return Boolean(canonical) && hasPhrase(prepared, canonical);
    const patterns = explicit.has(canonical) ? entry.all : entry.safe;
    return patterns.some((pattern) => hasPhrase(prepared, pattern));
};

/** Lexicon terms found in prepared text, in lexicon order. */
export const findLexiconTerms = (prepared, explicit = new Set()) =>
    SKILL_INDEX.filter((entry) => matchesSkill(prepared, entry.canonical, explicit)).map((entry) => entry.canonical);

/**
 * Canonical skills found in `text`: lexicon terms (lexicon order), then any `extra` skills that are
 * not in the lexicon, matched as phrases. Skills named in `extra` also unlock ambiguous terms.
 */
export const findSkillTerms = (text, { extra = [] } = {}) => {
    const explicit = new Set((Array.isArray(extra) ? extra : [extra]).map(canonicalizeSkill).filter(Boolean));
    const prepared = prepareMatchText(text);
    const found = findLexiconTerms(prepared, explicit);
    for (const term of explicit) {
        if (!BY_CANONICAL.has(term) && !found.includes(term) && hasPhrase(prepared, term)) found.push(term);
    }
    return found;
};
