// Pure patch helpers shared by tailoring (byok, RESUME-BYOK.md §9.5) and
// apply-patches (§8.3). No I/O.
//
//   validateAndLocatePatches(source, suggestions, isLatex) → {patches, skipped}
//   locatePatchesForApply(source, patches, {isLatex}) → {accepted, skipped}
//   applyLocatedPatches(source, accepted) → string
//
// Offsets are UTF-16 code-unit indexes (String.prototype.slice), end exclusive.
export const MAX_TAILOR_PATCHES = 25;
const ESCAPABLE = ["%", "&", "#"];

/** Strip the `[Ln] ` tag the prompt adds, from every line. */
export const stripLineTags = (value) => (typeof value === "string"
    ? value.split("\n").map((line) => line.replace(/^\[L\d+\][ \t]?/, "")).join("\n")
    : value);

/** Count of backslashes immediately before `index`. */
const backslashesBefore = (text, index) => {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) count += 1;
    return count;
};

const isEscapedAt = (text, index) => backslashesBefore(text, index) % 2 === 1;

/** Unescaped `{` minus unescaped `}` (a brace after an odd number of `\` is escaped). */
export const braceDelta = (text) => {
    let delta = 0;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if ((char === "{" || char === "}") && !isEscapedAt(text, index)) delta += char === "{" ? 1 : -1;
    }
    return delta;
};

const hasUnescaped = (text, char) => {
    for (let index = text.indexOf(char); index !== -1; index = text.indexOf(char, index + 1)) {
        if (!isEscapedAt(text, index)) return true;
    }
    return false;
};

/**
 * Escape unescaped `%`, `&` and `#` in a LaTeX replacement when the original
 * has no unescaped occurrence of that character (the model introduced it as text).
 */
export const autoEscapeLatex = (original, replacement) => {
    let text = replacement;
    let changed = false;
    for (const char of ESCAPABLE) {
        if (hasUnescaped(original, char)) continue;
        let out = "";
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] === char && !isEscapedAt(text, index)) {
                out += `\\${char}`;
                changed = true;
            } else {
                out += text[index];
            }
        }
        text = out;
    }
    return { text, changed };
};

/** Every start index of `needle` in `haystack`. */
export const occurrences = (haystack, needle) => {
    const found = [];
    if (!needle) return found;
    for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) found.push(index);
    return found;
};

/** 1-based line number of a character index. */
export const lineOf = (text, index) => {
    let line = 1;
    for (let cursor = text.indexOf("\n"); cursor !== -1 && cursor < index; cursor = text.indexOf("\n", cursor + 1)) line += 1;
    return line;
};

const lineRangeFor = (source, startChar, original) => {
    const startLine = lineOf(source, startChar);
    const newlines = (original.match(/\n/g) || []).length;
    const endLine = Math.max(startLine, startLine + newlines - (original.endsWith("\n") ? 1 : 0));
    return { startLine, endLine };
};

const capText = (value, max, fallback = "") => {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || fallback).slice(0, max);
};

const capKeywords = (value) => (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, 10)
    .map((item) => item.trim().slice(0, 60));

const nearestByLine = (source, starts, hintLine) => {
    let best = starts[0];
    let bestDistance = Infinity;
    for (const start of starts) {
        const distance = Math.abs(lineOf(source, start) - hintLine);
        if (distance < bestDistance) {
            best = start;
            bestDistance = distance;
        }
    }
    return best;
};

const nearestByIndex = (starts, hintIndex) => starts.reduce(
    (best, start) => (Math.abs(start - hintIndex) < Math.abs(best - hintIndex) ? start : best),
    starts[0],
);

/** Drop overlapping ranges (sorted by start); returns [kept, overlapping]. */
const removeOverlaps = (items) => {
    const kept = [];
    const overlapping = [];
    let lastEnd = -1;
    for (const item of [...items].sort((left, right) => left.charRange.startChar - right.charRange.startChar
        || left.order - right.order)) {
        if (item.charRange.startChar < lastEnd) {
            overlapping.push(item);
            continue;
        }
        kept.push(item);
        lastEnd = item.charRange.endChar;
    }
    return [kept, overlapping];
};

/**
 * Turn raw LLM suggestions into located, validated patches (RESUME-BYOK.md §9.5 step 8).
 * Hallucinated originals, unbalanced LaTeX, overlaps and extras are skipped with a reason.
 */
export const validateAndLocatePatches = (source, suggestions, isLatex) => {
    const skipped = [];
    const located = [];
    (Array.isArray(suggestions) ? suggestions : []).forEach((item, index) => {
        const label = typeof item?.id === "string" && item.id.trim() ? item.id.trim().slice(0, 40) : index;
        const original = stripLineTags(item?.originalSubstring);
        let replacement = stripLineTags(item?.replacementSubstring);
        if (typeof original !== "string" || typeof replacement !== "string" || !original || !replacement) {
            skipped.push({ id: label, reason: "invalid" });
            return;
        }
        if (original === replacement) {
            skipped.push({ id: label, reason: "unchanged" });
            return;
        }
        const starts = occurrences(source, original);
        if (!starts.length) {
            skipped.push({ id: label, reason: "not_found" });
            return;
        }
        let autoEscaped = false;
        if (isLatex) {
            if (braceDelta(replacement) !== braceDelta(original)) {
                skipped.push({ id: label, reason: "unbalanced_braces" });
                return;
            }
            const escaped = autoEscapeLatex(original, replacement);
            replacement = escaped.text;
            autoEscaped = escaped.changed;
            if (replacement === original) {
                skipped.push({ id: label, reason: "unchanged" });
                return;
            }
        }
        const hintLine = Number.parseInt(item?.lineNumber, 10);
        const startChar = nearestByLine(source, starts, Number.isFinite(hintLine) && hintLine > 0 ? hintLine : 1);
        located.push({
            order: index,
            label,
            section: capText(item?.section, 100, "General"),
            targetContext: capText(item?.targetContext, 200),
            lineRange: lineRangeFor(source, startChar, original),
            charRange: { startChar, endChar: startChar + original.length },
            originalSubstring: original,
            replacementSubstring: replacement,
            keywordsAdded: capKeywords(item?.keywordsAdded),
            reasoning: capText(item?.reasoning, 500),
            ...(autoEscaped ? { autoEscaped: true } : {}),
        });
    });

    const [kept, overlapping] = removeOverlaps(located);
    for (const item of overlapping) skipped.push({ id: item.label, reason: "overlap" });
    for (const item of kept.slice(MAX_TAILOR_PATCHES)) skipped.push({ id: item.label, reason: "limit" });

    const patches = kept.slice(0, MAX_TAILOR_PATCHES).map(({ order: _order, label: _label, ...patch }, index) => ({
        id: `patch_${index + 1}`,
        ...patch,
    }));
    return { patches, skipped };
};

/**
 * Locate client-chosen patches against the CURRENT source (§8.3 rules 3–5):
 * keep exact matches, relocate shifted ones to the nearest occurrence, skip
 * stale / overlapping / brace-unbalancing ones, auto-escape LaTeX specials.
 */
export const locatePatchesForApply = (source, patches, { isLatex = false } = {}) => {
    const skipped = [];
    const located = [];
    patches.forEach((patch, index) => {
        const id = String(patch.id ?? index);
        const original = patch.originalSubstring;
        let replacement = patch.replacementSubstring;
        const hint = Number(patch.charRange?.startChar);
        let startChar = -1;
        if (Number.isInteger(hint) && hint >= 0 && source.slice(hint, hint + original.length) === original) {
            startChar = hint;
        } else {
            const starts = occurrences(source, original);
            if (starts.length) startChar = nearestByIndex(starts, Number.isFinite(hint) ? hint : 0);
        }
        if (startChar === -1) {
            skipped.push({ id, reason: "stale" });
            return;
        }
        if (isLatex) {
            if (braceDelta(replacement) !== braceDelta(original)) {
                skipped.push({ id, reason: "unbalanced_braces" });
                return;
            }
            replacement = autoEscapeLatex(original, replacement).text;
        }
        located.push({
            id,
            order: index,
            charRange: { startChar, endChar: startChar + original.length },
            originalSubstring: original,
            replacementSubstring: replacement,
        });
    });
    const [kept, overlapping] = removeOverlaps(located);
    for (const item of overlapping) skipped.push({ id: item.id, reason: "overlap" });
    return { accepted: kept.map(({ order: _order, ...item }) => item), skipped };
};

/** Apply located, non-overlapping patches (descending start order). */
export const applyLocatedPatches = (source, accepted) => {
    let text = source;
    for (const patch of [...accepted].sort((left, right) => right.charRange.startChar - left.charRange.startChar)) {
        text = text.slice(0, patch.charRange.startChar) + patch.replacementSubstring + text.slice(patch.charRange.endChar);
    }
    return text;
};

/** Prefix every line with `[Ln] ` for the tailoring prompt. */
export const addLineNumbers = (text) => String(text).split("\n").map((line, index) => `[L${index + 1}] ${line}`).join("\n");
