// LaTeX source policy and exfiltration guard (docs/contracts/RESUME-BYOK.md §6.3).
//
// `tectonic --untrusted` still reads arbitrary files through \input{/abs/path},
// ^^5cinput, \csname input\endcsname, \openin/\read and ../ paths, so every
// compile path runs checkLatexPolicy() on the normalized source first.
//
// The scan is deliberately conservative: comments are scanned too (a `%` can be
// literal inside \verb, so stripping comments would open a bypass), and a
// rejected construct only costs the student an edit.
import { fail } from "../../../core/http.js";

// Rule 2: forbidden control words, matched as \name(?![A-Za-z@]).
const FORBIDDEN_WORDS = new Set([
    "csname", "catcode", "scantokens",
    "openin", "openout", "read", "readline", "write", "immediate", "closein", "closeout", "newread", "newwrite",
    "special", "directlua", "luaexec", "ShellEscape", "graphicspath",
    "XeTeXpicfile", "XeTeXpdffile",
    "pdfximage", "pdffiledump", "pdfmdfivesum", "pdffilesize", "pdffilemoddate",
    // Hardening beyond the contract's list (documented deviations):
    "XeTeXpdfpagecount",            // probes arbitrary PDF files by path
    "filecontents", "endfilecontents", // the environment invoked as commands (rule 5)
    // expl3 syntax makes `_`/`:` letters, which hides \file_input:n, \ior_open:Nn …
    // from this scanner, so expl3 syntax is not allowed in resume sources.
    "ExplSyntaxOn", "ProvidesExplPackage", "ProvidesExplClass", "ProvidesExplFile",
]);

// Rule 4: commands whose argument names files.
const PATH_COMMANDS = new Set([
    "documentclass", "usepackage", "RequirePackage", "LoadClass", "bibliography", "addbibresource",
    // Same risk, not listed in the contract (documented deviations):
    "RequirePackageWithOptions", "LoadClassWithOptions", "bibliographystyle", "externaldocument",
]);

// Commands that copy another command's meaning: `\let\x\input foo` followed by
// `\x{/etc/hosts}` would bypass the \input argument check.
const ALIAS_COMMANDS = "let|futurelet|LetLtxMacro|NewCommandCopy|RenewCommandCopy|DeclareCommandCopy|cslet|csletcs|letcs";
const ALIAS_BEFORE = new RegExp(
    `\\\\(?:${ALIAS_COMMANDS})(?![A-Za-z@])\\s*(?:(?:\\\\[A-Za-z@]+|\\\\[^A-Za-z@\\s]|\\{[^{}]*\\}|[^\\s\\\\{}=])\\s*){1,2}=?\\s*$`,
);

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_TEX_NAME = /^[A-Za-z0-9_-]+(\.tex)?$/;
const SAFE_GRAPHIC_NAME = /^[A-Za-z0-9_-]+(\.(png|jpe?g|pdf|eps))?$/i;

const lineAt = (text, index) => {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    return line;
};

const clipConstruct = (value) => {
    const flat = String(value).replace(/\s+/g, " ").trim();
    return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

/** Every control sequence in source order: {name, start, end, word}. `\\` is a control symbol. */
const controlSequences = (text) => {
    const out = [];
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== "\\") continue;
        const next = text[i + 1];
        if (next === undefined) break;
        if (/[A-Za-z@]/.test(next)) {
            let end = i + 1;
            while (end < text.length && /[A-Za-z@]/.test(text[end])) end += 1;
            out.push({ name: text.slice(i + 1, end), start: i, end, word: true });
            i = end - 1;
        } else {
            out.push({ name: next, start: i, end: i + 2, word: false });
            i += 1;
        }
    }
    return out;
};

const skipSpaces = (text, index) => {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    return i;
};

/** Read a `[...]` group starting at `index` (after spaces). Returns {content, end} or null. */
const readBracket = (text, index) => {
    const i = skipSpaces(text, index);
    if (text[i] !== "[") return null;
    const close = text.indexOf("]", i + 1);
    if (close === -1) return { content: text.slice(i + 1), end: text.length, unterminated: true };
    return { content: text.slice(i + 1, close), end: close + 1 };
};

/** Read a flat `{...}` group (no nested braces) at `index` (after spaces). */
const readBrace = (text, index) => {
    const i = skipSpaces(text, index);
    if (text[i] !== "{") return null;
    const match = /^\{([^{}]*)\}/.exec(text.slice(i));
    if (!match) return { content: null, end: i + 1 };
    return { content: match[1], end: i + match[0].length };
};

const isAliased = (text, start) => ALIAS_BEFORE.test(text.slice(Math.max(0, start - 200), start));

// Rule 3: \input / \include with a safe bundle/file name only.
const checkInputInclude = (text, cs) => {
    if (isAliased(text, cs.start)) return false;
    const after = cs.end;
    const brace = readBrace(text, after);
    if (brace) return brace.content !== null && SAFE_TEX_NAME.test(brace.content.trim());
    if (cs.name === "include") return false;
    // Bare name: TeX reads (and expands) the file name up to a space, so the
    // whole run up to whitespace / `%` must be a safe name. A control sequence,
    // `}`, a path or the end of input after \input is rejected.
    const i = skipSpaces(text, after);
    if (i >= text.length) return false;
    const run = /^[^\s%]+/.exec(text.slice(i));
    return Boolean(run) && SAFE_TEX_NAME.test(run[0]);
};

const checkIncludeGraphics = (text, cs) => {
    if (isAliased(text, cs.start)) return false;
    let index = cs.end;
    if (text[index] === "*") index += 1;
    for (let k = 0; k < 2; k += 1) {
        const bracket = readBracket(text, index);
        if (!bracket) break;
        if (bracket.unterminated) return false;
        index = bracket.end;
    }
    const brace = readBrace(text, index);
    return Boolean(brace) && brace.content !== null && SAFE_GRAPHIC_NAME.test(brace.content.trim());
};

const checkPathArgument = (text, cs) => {
    let index = cs.end;
    const bracket = readBracket(text, index);
    if (bracket) {
        if (bracket.unterminated) return { ok: false, construct: `\\${cs.name}[` };
        index = bracket.end;
    }
    const brace = readBrace(text, index);
    if (!brace || brace.content === null) return { ok: false, construct: `\\${cs.name}` };
    const names = brace.content.split(",").map((name) => name.trim()).filter(Boolean);
    const ok = names.length > 0 && names.every((name) => SAFE_NAME.test(name));
    return ok ? { ok: true } : { ok: false, construct: `\\${cs.name}{${brace.content}}` };
};

// Rule 6: \font\x="[path]" / \font\x=[path] and Path= inside font option lists.
const FONT_FILE_PATH = /^\s*\\[A-Za-z@]+\s*=?\s*"?\s*\[/;
const PATH_KEY = /(^|[,\s])Path\s*=/i;

const checkFontOptions = (text, cs) => {
    let index = cs.end;
    for (let k = 0; k < 4; k += 1) {
        const i = skipSpaces(text, index);
        if (text[i] === "[") {
            const bracket = readBracket(text, i);
            if (PATH_KEY.test(bracket.content)) return false;
            index = bracket.end;
        } else if (text[i] === "{") {
            const brace = readBrace(text, i);
            if (brace.content === null) break;
            index = brace.end;
        } else {
            break;
        }
    }
    return true;
};

/**
 * @param {string} source normalized LaTeX (before the pdfTeX shim)
 * @returns {{ok: true} | {ok: false, construct: string, line: number}}
 */
export const checkLatexPolicy = (source) => {
    const text = String(source ?? "");
    const violations = [];
    const reject = (index, construct) => violations.push({ index, construct: clipConstruct(construct) });

    // Rule 1: TeX hex escapes (^^5c spells a backslash).
    const hat = text.indexOf("^^");
    if (hat !== -1) reject(hat, "^^");

    // Rule 5: filecontents environments.
    const filecontents = /\\begin\s*\{\s*filecontents\*?\s*\}/.exec(text);
    if (filecontents) reject(filecontents.index, filecontents[0]);

    for (const cs of controlSequences(text)) {
        if (!cs.word) continue;
        const { name } = cs;
        const lower = name.toLowerCase();

        if (FORBIDDEN_WORDS.has(name)) {
            reject(cs.start, `\\${name}`);
            continue;
        }
        if (name === "input" || name === "include") {
            if (!checkInputInclude(text, cs)) {
                const brace = readBrace(text, cs.end);
                reject(cs.start, brace?.content != null ? `\\${name}{${brace.content}}` : `\\${name}`);
            }
            continue;
        }
        if (name === "includegraphics") {
            if (!checkIncludeGraphics(text, cs)) reject(cs.start, `\\${name}`);
            continue;
        }
        if (lower.includes("input") || lower.includes("include") || lower.includes("import")) {
            reject(cs.start, `\\${name}`);
            continue;
        }
        if (PATH_COMMANDS.has(name)) {
            const result = checkPathArgument(text, cs);
            if (!result.ok) reject(cs.start, result.construct);
            continue;
        }
        if (name === "font") {
            if (FONT_FILE_PATH.test(text.slice(cs.end, cs.end + 200))) reject(cs.start, "\\font");
            continue;
        }
        if (lower.includes("font") && !checkFontOptions(text, cs)) {
            reject(cs.start, `\\${name}[Path=…]`);
        }
    }

    if (violations.length === 0) return { ok: true };
    violations.sort((a, b) => a.index - b.index);
    const first = violations[0];
    return { ok: false, construct: first.construct, line: lineAt(text, first.index) };
};

/** Throws 422 LATEX_FORBIDDEN unless the source passes the policy. */
export const assertLatexPolicy = (source) => {
    const result = checkLatexPolicy(source);
    if (result.ok) return result;
    throw fail(
        422,
        `For security, \`${result.construct}\` is not allowed (line ${result.line}). Remove it and compile again.`,
        "LATEX_FORBIDDEN",
        { construct: result.construct, line: result.line },
    );
};

const SECRET_NAME = /(SECRET|PASS(WORD)?|TOKEN|KEY|MONGO_?URI|MONGODB_URI|DATABASE_URL)$/i;

/** Values (≥ 12 chars) of env vars that look like secrets, read at call time. Longest first. */
export const secretEnvValues = () => {
    const values = new Set();
    for (const [name, value] of Object.entries(process.env)) {
        if (!SECRET_NAME.test(name) || typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed.length >= 12) values.add(trimmed);
    }
    return [...values].sort((a, b) => b.length - a.length);
};

/** Replace every secret env value in `text` with "[redacted]". */
export const redactSecrets = (text) => {
    let out = String(text ?? "");
    for (const secret of secretEnvValues()) out = out.split(secret).join("[redacted]");
    return out;
};
