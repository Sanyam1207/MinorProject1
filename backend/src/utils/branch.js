// The product's ONLY branch/department canonicaliser (docs/contracts/AUTH-FACULTY.md §6.3).
// Used for student `branch`, teacher `department`, `College.branches/departments`,
// GGSIPU program names and the demo seed. Placements and attendance compare
// branches through it; add rules here instead of keeping local alias tables.
//
//   canonicalBranch("BACHELOR OF TECHNOLOGY (COMPUTER SCIENCE AND ENGINEERING)") → "CSE"
//   canonicalBranch("Information Technology") → "IT"
//   canonicalBranch("Training & Placement") → "Training & Placement" (no rule matches)

export const BRANCH_MAX_LENGTH = 60;

/** lowercase, `&` → " and ", punctuation → space, collapsed spaces. */
export const normalizeBranchText = (value) => String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const has = (text, phrase) => text.includes(phrase);

// First matching rule wins (order matters: AIML/AIDS before CSE, EEE before EE).
const RULES = [
    ["AIML", (t) => /\b(aiml|ai ml)\b/.test(t) || (has(t, "artificial intelligence") && has(t, "machine learning"))],
    ["AIDS", (t) => /\b(aids|ai ds)\b/.test(t) || (has(t, "artificial intelligence") && has(t, "data science"))],
    ["CSE", (t) => /\b(cse|cs)\b/.test(t) || has(t, "computer science") || has(t, "computer engineering")],
    ["IT", (t) => /\bit\b/.test(t) || has(t, "information technology")],
    ["ECE", (t) => /\bece\b/.test(t) || has(t, "electronics and communication")],
    ["EEE", (t) => /\beee\b/.test(t) || has(t, "electrical and electronics")],
    ["EE", (t) => /\bee\b/.test(t) || has(t, "electrical")],
    ["ME", (t) => /\b(me|mech)\b/.test(t) || has(t, "mechanical")],
    ["CE", (t) => /\bce\b/.test(t) || has(t, "civil")],
];

/**
 * Canonical short code (AIML, AIDS, CSE, IT, ECE, EEE, EE, ME, CE) or the
 * original trimmed value cut to 60 characters. Empty input gives "".
 */
export const canonicalBranch = (value) => {
    if (value === null || value === undefined) return "";
    const original = String(value).trim();
    if (!original) return "";
    const text = normalizeBranchText(original);
    for (const [code, matches] of RULES) {
        if (matches(text)) return code;
    }
    return original.slice(0, BRANCH_MAX_LENGTH);
};

/** Canonicalise and de-duplicate a list (case-insensitive), dropping empty entries. */
export const canonicalBranchList = (values) => {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
        const branch = canonicalBranch(value);
        const key = branch.toLowerCase();
        if (!branch || seen.has(key)) continue;
        seen.add(key);
        out.push(branch);
    }
    return out;
};
