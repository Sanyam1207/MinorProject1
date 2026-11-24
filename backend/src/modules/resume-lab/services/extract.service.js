// Type sniffing and text extraction (docs/contracts/RESUME-BYOK.md §4).
//
//   sniffAndExtract(buffer, {filename}) → {kind, source?, extractedText, meta, sha256, contentType, extension}
//   latexToText(source) → plain text (deterministic, pure)
//   normalizeExtractedText(text) → {text, truncated}
//
// Types are detected from the BYTES, never from the name or the client MIME type.
// An extension can only make the upload stricter (a `.pdf` whose bytes are not a
// PDF is rejected); it never upgrades or downgrades the detected kind.
import crypto from "node:crypto";
import { fail } from "../../../core/http.js";
import { EXTRACTED_TEXT_MAX } from "../config.js";

export const CONTENT_TYPES = Object.freeze({
    latex: "application/x-tex",
    text: "text/plain",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

export const NO_TEXT_WARNING = "No selectable text found. ATS systems likely can't read this file either (scanned or image-only PDF?).";
const UNSUPPORTED_MESSAGE = "This file type isn't supported. Save it as PDF or DOCX (or upload a .tex / .txt file).";

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9+#.'/-]*/g;
export const countWords = (text) => (String(text || "").match(WORD_RE) || []).length;
export const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

const unsupported = (message = UNSUPPORTED_MESSAGE) => fail(415, message, "UNSUPPORTED_FILE_TYPE");
const unreadable = (message) => fail(422, message, "UNREADABLE_FILE");

const startsWith = (buffer, bytes) => buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/** Trim lines, collapse runs of spaces and blank lines, cap at 100 000 chars. */
export const normalizeExtractedText = (text) => {
    const lines = String(text ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/ /g, " ")
        .split("\n")
        .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());
    const collapsed = [];
    for (const line of lines) {
        if (!line && (collapsed.length === 0 || collapsed[collapsed.length - 1] === "")) continue;
        collapsed.push(line);
    }
    while (collapsed.length && collapsed[collapsed.length - 1] === "") collapsed.pop();
    const joined = collapsed.join("\n");
    if (joined.length > EXTRACTED_TEXT_MAX) return { text: joined.slice(0, EXTRACTED_TEXT_MAX), truncated: true };
    return { text: joined, truncated: false };
};

/** `meta` for a resume from its extracted text. */
export const buildMeta = ({ text, pages = null, truncated = false, kind }) => {
    const words = countWords(text);
    const lowText = (kind === "pdf" || kind === "docx") && String(text || "").length < 200;
    return {
        pages: Number.isFinite(pages) ? pages : null,
        words,
        chars: String(text || "").length,
        truncated: Boolean(truncated),
        extractionWarning: lowText ? NO_TEXT_WARNING : null,
    };
};

// ── LaTeX → text ───────────────────────────────────────────────────────────

const NAME_RE = /[A-Za-z@]+/y;

/** Index of the delimiter closing the group opened at text[start]; -1 when unbalanced. */
const closingIndex = (text, start, open, close) => {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === open) depth += 1;
        else if (char === close) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
};

const skipSpaces = (text, index) => {
    let cursor = index;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
    return cursor;
};

/**
 * Rewrite every control word accepted by `matches(name)`. The command, an
 * optional `*`, an optional `[...]` and up to `groups` brace groups are passed
 * to `render(name, args)` and replaced by its result.
 */
const rewriteCommands = (text, matches, groups, render) => {
    let out = "";
    let cursor = 0;
    while (cursor < text.length) {
        const slash = text.indexOf("\\", cursor);
        if (slash === -1) {
            out += text.slice(cursor);
            break;
        }
        out += text.slice(cursor, slash);
        NAME_RE.lastIndex = slash + 1;
        const match = NAME_RE.exec(text);
        if (!match) {
            // control symbol (\\, \%, \{ …): copy both characters untouched
            out += text.slice(slash, slash + 2);
            cursor = slash + 2;
            continue;
        }
        const name = match[0];
        let end = slash + 1 + name.length;
        if (!matches(name)) {
            out += text.slice(slash, end);
            cursor = end;
            continue;
        }
        if (text[end] === "*") end += 1;
        let probe = skipSpaces(text, end);
        if (text[probe] === "[") {
            const close = closingIndex(text, probe, "[", "]");
            if (close !== -1) end = close + 1;
        }
        const args = [];
        while (args.length < groups) {
            probe = skipSpaces(text, end);
            if (text[probe] !== "{") break;
            const close = closingIndex(text, probe, "{", "}");
            if (close === -1) break;
            args.push(text.slice(probe + 1, close));
            end = close + 1;
        }
        out += render(name, args);
        cursor = end;
    }
    return out;
};

// Placeholders (private-use characters) protect escaped specials through brace removal.
const LBRACE = "";
const RBRACE = "";
const DOLLAR = "";
const AMP = "";

/** Deterministic LaTeX → plain text (RESUME-BYOK.md §4, steps 1–10). */
export const latexToText = (source) => {
    let text = String(source ?? "").replace(/\r\n?/g, "\n");

    // 1. Drop % comments: an unescaped % (preceded by an even number of backslashes) to end of line.
    text = text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, "$1$2");

    // 2. Keep only the document body.
    const begin = text.indexOf("\\begin{document}");
    if (begin !== -1) {
        const bodyStart = begin + "\\begin{document}".length;
        const endIndex = text.indexOf("\\end{document}", bodyStart);
        text = text.slice(bodyStart, endIndex === -1 ? undefined : endIndex);
    }

    // 3. Section-like commands → their title on its own line.
    text = rewriteCommands(text, (name) => /section/i.test(name), 1, (_name, [title = ""]) => `\n${title}\n`);

    // 4. Item-like commands → bullet, keeping their brace content in place.
    text = rewriteCommands(text, (name) => /item/i.test(name), 0, () => "\n• ");

    // 5. Links.
    text = rewriteCommands(text, (name) => name === "href", 2, (_name, [url = "", label = ""]) =>
        (label.trim() ? `${label} (${url})` : url));
    text = rewriteCommands(text, (name) => name === "url", 1, (_name, [url = ""]) => url);

    // 6. Spacing / line-break commands.
    text = text.replace(/\\\\\*?(\s*\[[^\]\n]*\])?/g, "\n");
    text = rewriteCommands(text, (name) => name === "newline" || name === "linebreak", 0, () => "\n");
    text = rewriteCommands(text, (name) => name === "vspace" || name === "hspace", 1, () => "");
    text = rewriteCommands(text, (name) => name === "hfill", 0, () => " ");

    // 7. Environments → newline (dropping tabular/minipage geometry arguments).
    text = text.replace(/\\(begin|end)\s*\{([^}]*)\}(\s*\[[^\]\n]*\])?/g, (_match, which, env) => {
        if (which === "begin" && /^(tabular\*?|tabularx|minipage|multicols|longtable)$/.test(env.trim())) return "\n";
        return "\n";
    });
    text = text.replace(/((?:\s*(?:\[[^\]\n]*\]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}))*)/g, "");

    // 8. Escapes and typographic ligatures.
    text = text
        .replace(/\\%/g, "%")
        .replace(/\\&/g, AMP)
        .replace(/\\\$/g, DOLLAR)
        .replace(/\\#/g, "#")
        .replace(/\\_/g, "_")
        .replace(/\\\{/g, LBRACE)
        .replace(/\\\}/g, RBRACE)
        .replace(/\$\s*\|\s*\$/g, " | ")
        .replace(/\\textbar\b(\{\})?/g, " | ")
        .replace(/(^|[^\\])~/g, "$1 ")
        .replace(/---/g, "—")
        .replace(/--/g, "–");

    // 9. Remaining control words (+ optional [...]), control symbols, argument separators, braces.
    text = text.replace(/\\[A-Za-z@]+\*?(\s*\[[^\]\n]*\])?/g, " ");
    text = text.replace(/\\\s/g, " ").replace(/\\[^A-Za-z\s]/g, "");
    text = text.replace(/\}[ \t]*\{/g, " | ");
    text = text.replace(/[{}$]/g, "");
    text = text.replace(/&/g, " ");
    text = text
        .replace(new RegExp(LBRACE, "g"), "{")
        .replace(new RegExp(RBRACE, "g"), "}")
        .replace(new RegExp(DOLLAR, "g"), "$")
        .replace(new RegExp(AMP, "g"), "&");

    // 10. Tidy: collapse spaces, trim lines, drop near-empty bullets, collapse blank lines.
    const lines = text.split("\n").map((line) => line.replace(/[ \t ]+/g, " ").trim()
        .replace(/^\|\s*/, "").replace(/\s*\|$/, ""));
    const kept = [];
    for (const line of lines) {
        if (line.startsWith("•")) {
            const words = line.slice(1).trim().split(/\s+/).filter(Boolean);
            if (words.length < 2) continue;
            kept.push(`• ${words.join(" ")}`);
            continue;
        }
        if (!line && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
        kept.push(line);
    }
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    return kept.join("\n");
};

// ── Binary extraction ────────────────────────────────────────────────────

const decodeUtf8 = (buffer) => {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        if (text.includes("\u0000")) return null;
        return text.replace(/^﻿/, "");
    } catch {
        return null;
    }
};

export const looksLikeLatex = (text, filename = "") =>
    /\.tex$/i.test(filename) || text.includes("\\documentclass") || text.includes("\\begin{document}");

const htmlToText = (html) => String(html || "")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/?(p|h[1-6]|tr|ul|ol|table|div)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const extractPdf = async (buffer) => {
    const { getDocumentProxy, extractText } = await import("unpdf");
    let doc;
    try {
        doc = await getDocumentProxy(new Uint8Array(buffer));
    } catch (error) {
        const encrypted = /password/i.test(`${error?.name} ${error?.message}`);
        throw unreadable(encrypted
            ? "This PDF is password-protected. Remove the password and upload it again."
            : "This PDF could not be read. It may be corrupt — export it again and retry.");
    }
    try {
        const { totalPages, text } = await extractText(doc, { mergePages: true });
        return { text: String(text || ""), pages: Number(totalPages) || null };
    } catch {
        throw unreadable("The text of this PDF could not be read. Export it again and retry.");
    } finally {
        await doc.destroy?.().catch?.(() => {});
    }
};

const isDocxZip = (buffer) => buffer.includes(Buffer.from("word/document.xml"));

const extractDocx = async (buffer) => {
    const { default: mammoth } = await import("mammoth");
    try {
        const { value } = await mammoth.convertToHtml({ buffer });
        return { text: htmlToText(value), pages: null };
    } catch {
        throw unreadable("This DOCX file could not be read. Open it in Word or Google Docs, save it again and retry.");
    }
};

/**
 * Detect the kind of an uploaded buffer and extract its text.
 * @returns {Promise<{kind, source: string|null, extractedText, meta, sha256, contentType, extension}>}
 */
export const sniffAndExtract = async (buffer, { filename = "" } = {}) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, "The uploaded file is empty", "VALIDATION", { field: "file" });
    const name = String(filename || "").toLowerCase();
    const claims = name.endsWith(".pdf") ? "pdf" : name.endsWith(".docx") ? "docx" : name.endsWith(".doc") ? "doc" : null;
    const sha256 = sha256Hex(buffer);

    if (startsWith(buffer, PDF_MAGIC)) {
        if (claims && claims !== "pdf") throw unsupported();
        const { text, pages } = await extractPdf(buffer);
        const normalized = normalizeExtractedText(text);
        return {
            kind: "pdf", source: null, extractedText: normalized.text, sha256, contentType: CONTENT_TYPES.pdf, extension: "pdf",
            meta: buildMeta({ text: normalized.text, pages, truncated: normalized.truncated, kind: "pdf" }),
        };
    }
    if (startsWith(buffer, ZIP_MAGIC)) {
        if (claims && claims !== "docx") throw unsupported();
        if (!isDocxZip(buffer)) throw unsupported();
        const { text } = await extractDocx(buffer);
        const normalized = normalizeExtractedText(text);
        return {
            kind: "docx", source: null, extractedText: normalized.text, sha256, contentType: CONTENT_TYPES.docx, extension: "docx",
            meta: buildMeta({ text: normalized.text, pages: null, truncated: normalized.truncated, kind: "docx" }),
        };
    }
    if (startsWith(buffer, OLE_MAGIC)) {
        throw unsupported("Legacy .doc files aren't supported. Save it as PDF or DOCX and upload it again.");
    }
    if (claims) throw unsupported(`This file is named .${claims} but its contents aren't a ${claims.toUpperCase()} file. Save it as PDF or DOCX and upload it again.`);

    const decoded = decodeUtf8(buffer);
    if (decoded === null) throw unsupported();
    const text = decoded.replace(/\r\n?/g, "\n");
    if (!text.trim()) throw fail(400, "The uploaded file is empty", "VALIDATION", { field: "file" });
    return describeText(text, { filename: name, sha256 });
};

/** Describe pasted / uploaded text as a latex or text resume. */
export const describeText = (rawText, { filename = "", kind: forcedKind = null, sha256 = null } = {}) => {
    const source = String(rawText ?? "").replace(/\r\n?/g, "\n");
    const kind = forcedKind || (looksLikeLatex(source, filename) ? "latex" : "text");
    const normalized = normalizeExtractedText(kind === "latex" ? latexToText(source) : source);
    return {
        kind,
        source,
        extractedText: normalized.text,
        sha256: sha256 || sha256Hex(Buffer.from(source, "utf8")),
        contentType: CONTENT_TYPES[kind],
        extension: kind === "latex" ? "tex" : "txt",
        meta: buildMeta({ text: normalized.text, pages: null, truncated: normalized.truncated, kind }),
    };
};
