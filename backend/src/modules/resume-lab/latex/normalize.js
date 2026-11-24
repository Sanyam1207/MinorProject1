// LaTeX source normalization before the policy check and compile
// (docs/contracts/RESUME-BYOK.md §6.2).
//
//   normalizeLatexSource(source)  steps 1–3 (line endings, fences, over-escaped
//                                 mode, hyperref pdftex option)
//   withPdftexShim(source)        step 4: pdfTeX compatibility shim for XeTeX,
//                                 prepended to line 1 WITHOUT a newline so the
//                                 user's line numbers stay unchanged.
//
// The policy (policy.js) scans the normalized source BEFORE the shim is added.

/** Exact shim text (§6.2 step 4). Ends with a space, never with a newline. */
export const PDFTEX_SHIM = "\\ifdefined\\pdfgentounicode\\else\\newcount\\pdfgentounicode\\fi"
    + "\\ifdefined\\pdfglyphtounicode\\else\\def\\pdfglyphtounicode#1#2{}\\fi ";

// Over-escaped sources (LaTeX that went through JSON/string escaping twice)
// contain a literal `\\documentclass` or `\\begin{document}`.
const OVER_ESCAPED_MARKER = /\\\\documentclass|\\\\begin\s*\{document\}/;

const stripFences = (text) => text
    .replace(/^\s*```(?:latex|tex)?[^\S\n]*(?:\n|$)/i, "")
    .replace(/(?:^|\n)[^\S\n]*```\s*$/, "");

const removeHyperrefPdftex = (text) => text.replace(
    /(\\usepackage\s*\[)([^\]]*)(\]\s*\{\s*hyperref\s*\})/gi,
    (_match, prefix, options, suffix) => {
        const kept = options
            .split(",")
            .map((option) => option.trim())
            .filter((option) => option && option.toLowerCase() !== "pdftex");
        return `${prefix}${kept.join(",")}${suffix}`;
    },
);

/**
 * §6.2 steps 1–3. Pure; never throws for string input.
 * Outside over-escaped mode `\\` line breaks are never touched (fixes Matchy
 * corrupting `\\Next`).
 * @param {string} source
 * @returns {string}
 */
export const normalizeLatexSource = (source) => {
    let text = String(source ?? "").replace(/\r\n?/g, "\n");
    text = stripFences(text);

    if (OVER_ESCAPED_MARKER.test(text)) {
        // A literal `\n` before whitespace, end of input or another backslash
        // is an escaped newline in this mode (`\n` followed by `\\begin` would
        // otherwise become the undefined control word \n).
        text = text.replace(/\\n(?=\s|$|\\)/g, "\n");
        text = text.replace(/\\{2,}(?=[A-Za-z])/g, "\\");
    }

    return removeHyperrefPdftex(text);
};

/** §6.2 step 4: prepend the shim to line 1 (no newline added). */
export const withPdftexShim = (source) => `${PDFTEX_SHIM}${String(source ?? "")}`;
