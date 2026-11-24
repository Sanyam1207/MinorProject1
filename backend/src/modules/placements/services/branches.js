// Branch matching (docs/contracts/PLACEMENTS.md §2.5).
//
// The product has ONE branch canonicaliser: canonicalBranch() in backend/src/utils/branch.js
// (owned by AUTH-FACULTY §6.3). This file only wraps it. Until that shared util is merged, the
// identical §6.3 rule table below is used so placements keeps working; once the util exists it
// always wins.

const normalizeForRules = (value) => String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// AUTH-FACULTY §6.3, verbatim (used only while utils/branch.js is absent).
const contractCanonicalBranch = (value) => {
    const original = String(value ?? "").trim();
    if (!original) return "";
    const text = normalizeForRules(original);
    const has = (phrase) => text.includes(phrase);
    if (/\b(aiml|ai ml)\b/.test(text) || (has("artificial intelligence") && has("machine learning"))) return "AIML";
    if (/\b(aids|ai ds)\b/.test(text) || (has("artificial intelligence") && has("data science"))) return "AIDS";
    if (/\b(cse|cs)\b/.test(text) || has("computer science") || has("computer engineering")) return "CSE";
    if (/\bit\b/.test(text) || has("information technology")) return "IT";
    if (/\bece\b/.test(text) || has("electronics and communication")) return "ECE";
    if (/\beee\b/.test(text) || has("electrical and electronics")) return "EEE";
    if (/\bee\b/.test(text) || has("electrical")) return "EE";
    if (/\b(me|mech)\b/.test(text) || has("mechanical")) return "ME";
    if (/\bce\b/.test(text) || has("civil")) return "CE";
    return original.slice(0, 60);
};

let sharedCanonicalBranch = null;
try {
    const shared = await import("../../../utils/branch.js");
    if (typeof shared.canonicalBranch === "function") sharedCanonicalBranch = shared.canonicalBranch;
} catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

/** The shared canonicaliser (AUTH-FACULTY §6.3). */
export const canonicalBranch = (value) => {
    const result = (sharedCanonicalBranch || contractCanonicalBranch)(value);
    return typeof result === "string" ? result : String(result ?? "");
};

/** Lowercase; "&" → " and "; non-[a-z0-9] → space; collapsed spaces. */
export const normalizeText = (value) => normalizeForRules(value);

const UNRESTRICTED = new Set(["all", "any", "all branches", "all streams", "open to all"]);

export const isUnrestricted = (list) => {
    const entries = Array.isArray(list) ? list.filter((entry) => String(entry ?? "").trim()) : [];
    if (entries.length === 0) return true;
    return entries.some((entry) => UNRESTRICTED.has(normalizeText(entry)));
};

const branchKey = (value) => normalizeText(canonicalBranch(value));

export const branchMatches = (studentBranch, allowed) => {
    if (isUnrestricted(allowed)) return true;
    const mine = branchKey(studentBranch);
    if (!mine) return false;
    return allowed.some((entry) => branchKey(entry) === mine);
};

/** Grouping label for stats: canonicalBranch(s) or "Unspecified". */
export const branchLabel = (value) => {
    const label = String(value ?? "").trim() ? canonicalBranch(value) : "";
    return label || "Unspecified";
};
