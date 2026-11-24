// Local LaTeX compiler: Tectonic (XeTeX) in a throw-away directory
// (docs/contracts/RESUME-BYOK.md §6.1–§6.3). Replaces latexonline.cc everywhere.
//
//   compileLatex(source, {userId}) → {pdf: Buffer, texErrors, ms, cached}
//
// Pipeline: size checks → normalize (§6.2 steps 1–3) → source policy (§6.3) →
// pdfTeX shim (§6.2 step 4) → in-memory LRU → semaphore/queue → tectonic
// `--untrusted` with an allowlisted environment → secret scan of the PDF text.
// Every failure is an ApiError with the §8.0 codes. The binary, timeout and
// limits are read at call time.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail } from "../../../core/http.js";
import {
    latexCacheEntries,
    latexCompileTimeoutMs,
    latexMaxConcurrent,
    latexMaxQueue,
    latexQueueWaitMs,
    maxSourceBytes,
    tectonicBin,
} from "../config.js";
import { normalizeLatexSource, withPdftexShim } from "./normalize.js";
import { assertLatexPolicy, redactSecrets, secretEnvValues } from "./policy.js";

const TMP_PREFIX = "mpc-latex-";
const MAX_BUFFER = 1024 * 1024;
const CACHE_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const LOG_MAX_LINES = 8;
const LOG_MAX_CHARS = 1500;
const ENV_ALLOWLIST = [
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "XDG_CACHE_HOME", "TECTONIC_CACHE_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
];
const TEX_DIAGNOSTIC = /^error: [^:\s]+:\d+:/;
const LOG_LINE = /^(error:|!|l\.\d+)/;
const OFFLINE_HINT = /download|fetch|resolve host|network|bundle/i;

// ── In-memory LRU of compiled PDFs (keyed by sha256 of the final source) ──
const cache = new Map();

const cacheGet = (key) => {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
};

const cachePut = (key, entry) => {
    const limit = latexCacheEntries();
    if (limit <= 0 || entry.pdf.length > CACHE_ENTRY_MAX_BYTES) return;
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
};

/** TEST HOOK: forget every cached PDF. */
export const _resetLatexCache = () => cache.clear();

// ── Semaphore with a bounded waiting queue ──
let active = 0;
const waiters = [];

const busy = () => fail(429, "The LaTeX compiler is busy. Try again in a moment.", "COMPILER_BUSY");

const acquire = () => {
    if (active < latexMaxConcurrent()) {
        active += 1;
        return Promise.resolve();
    }
    if (waiters.length >= latexMaxQueue()) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(busy());
        }, latexQueueWaitMs());
        waiter.timer.unref?.();
        waiters.push(waiter);
    });
};

const release = () => {
    const next = waiters.shift();
    if (next) {
        clearTimeout(next.timer);
        next.resolve(); // the slot passes straight to the next waiter
        return;
    }
    active = Math.max(0, active - 1);
};

// ── Helpers ──
const childEnv = () => {
    const env = {};
    for (const name of ENV_ALLOWLIST) {
        if (typeof process.env[name] === "string" && process.env[name] !== "") env[name] = process.env[name];
    }
    return env;
};

const run = (bin, args, options) => new Promise((resolve) => {
    execFile(bin, args, options, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
});

const isExecutable = (file) => {
    try {
        if (!statSync(file).isFile()) return false;
        accessSync(file, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/** Whether the configured Tectonic binary exists (sync; no process is started). */
export const hasTectonic = () => {
    const bin = tectonicBin();
    if (!bin) return false;
    if (bin.includes("/") || bin.includes(path.sep)) return isExecutable(path.resolve(bin));
    const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
    return dirs.some((dir) => exts.some((ext) => isExecutable(path.join(dir, bin + ext))));
};

const sanitizeOutput = (text) => redactSecrets(String(text ?? ""))
    // Absolute temp paths (…/mpc-latex-XXXXXX/resume.tex) → resume.tex
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:\\/'"`]+)*[\\/]mpc-latex-[A-Za-z0-9]+[\\/]?/g, "")
    .replace(/\r/g, "");

const conciseLog = (output) => {
    const seen = new Set();
    const lines = [];
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (!LOG_LINE.test(line) || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
        if (lines.length >= LOG_MAX_LINES) break;
    }
    const log = lines.join("\n");
    return log.length > LOG_MAX_CHARS ? `${log.slice(0, LOG_MAX_CHARS - 1)}…` : log;
};

const firstErrorLine = (output) => {
    const match = /resume\.tex:(\d+)|(?:^|[\s(])l\.(\d+)/m.exec(output);
    if (!match) return null;
    const line = Number(match[1] ?? match[2]);
    return Number.isFinite(line) && line > 0 ? line : null;
};

const countDiagnostics = (stderr) => new Set(
    stderr.split("\n").map((line) => line.trim()).filter((line) => TEX_DIAGNOSTIC.test(line)),
).size;

const compileFailed = (output, message = "Your LaTeX could not be compiled. Fix the errors in the log and try again.") => {
    const clean = sanitizeOutput(output);
    return fail(422, message, "LATEX_COMPILE_FAILED", { log: conciseLog(clean), line: firstErrorLine(clean) });
};

const normalizeSpace = (value) => String(value).replace(/\s+/g, "");

/** Throws 422 LATEX_FORBIDDEN {construct:"secret"} when the PDF text contains a secret env value. */
const scanForSecrets = async (pdf, userId) => {
    const secrets = secretEnvValues().map(normalizeSpace).filter((value) => value.length >= 12);
    if (secrets.length === 0) return;
    let text;
    try {
        const { getDocumentProxy, extractText } = await import("unpdf");
        const doc = await getDocumentProxy(new Uint8Array(pdf));
        const result = await extractText(doc, { mergePages: true });
        text = normalizeSpace(Array.isArray(result.text) ? result.text.join("") : result.text);
    } catch (error) {
        // Fail closed: a PDF that cannot be verified is never returned.
        console.warn(`[resume-lab] could not verify a compiled PDF: ${error?.message || error}`);
        throw fail(422, "The compiled PDF could not be verified. Simplify the document and try again.", "LATEX_COMPILE_FAILED", { log: "", line: null });
    }
    if (secrets.some((secret) => text.includes(secret))) {
        console.warn(`[resume-lab] blocked secret exfiltration attempt by ${userId ? String(userId) : "unknown user"}`);
        throw fail(
            422,
            "For security, this document is not allowed: it prints server configuration values. Remove them and compile again.",
            "LATEX_FORBIDDEN",
            { construct: "secret", line: null },
        );
    }
};

const runTectonic = async (finalSource) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
    try {
        await writeFile(path.join(dir, "resume.tex"), finalSource, "utf8");
        const { error, stdout, stderr } = await run(
            tectonicBin(),
            ["-Z", "continue-on-errors", "--untrusted", "--outdir", dir, "resume.tex"],
            { cwd: dir, timeout: latexCompileTimeoutMs(), maxBuffer: MAX_BUFFER, env: childEnv(), windowsHide: true },
        );
        const output = `${stderr}\n${stdout}`;

        if (error) {
            if (error.code === "ENOENT" || error.code === "EACCES") {
                throw fail(503, "The LaTeX compiler is not available on this server.", "COMPILER_UNAVAILABLE");
            }
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw compileFailed(output);
            if (error.killed === true || error.signal === "SIGTERM") {
                throw fail(504, "LaTeX compilation took too long and was stopped. Simplify the document and try again.", "LATEX_COMPILE_TIMEOUT");
            }
            const hasDiagnostics = output.split("\n").some((line) => TEX_DIAGNOSTIC.test(line.trim()));
            if (OFFLINE_HINT.test(output) && !hasDiagnostics) {
                throw fail(503, "LaTeX packages could not be downloaded — is the server offline?", "COMPILER_UNAVAILABLE");
            }
            throw compileFailed(output);
        }

        let pdf = null;
        try {
            pdf = await readFile(path.join(dir, "resume.pdf"));
        } catch {
            pdf = null;
        }
        if (!pdf || pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
            throw compileFailed(output, "Your LaTeX did not produce a PDF. Fix the errors in the log and try again.");
        }
        return { pdf, texErrors: countDiagnostics(stderr) };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * Compile LaTeX to PDF.
 * @param {string} source the user's LaTeX
 * @param {{userId?: string}} [options] userId is only used in the security log
 * @returns {Promise<{pdf: Buffer, texErrors: number, ms: number, cached: boolean}>}
 */
export const compileLatex = async (source, { userId } = {}) => {
    const started = Date.now();
    if (typeof source !== "string" || !source.trim()) {
        throw fail(400, "LaTeX source is required.", "VALIDATION", { field: "latex" });
    }
    const limit = maxSourceBytes();
    if (Buffer.byteLength(source, "utf8") > limit) {
        throw fail(413, `LaTeX source must be at most ${Math.floor(limit / 1024)} KB.`, "SOURCE_TOO_LARGE");
    }

    const normalized = normalizeLatexSource(source);
    if (!normalized.trim()) throw fail(400, "LaTeX source is required.", "VALIDATION", { field: "latex" });
    assertLatexPolicy(normalized);
    const finalSource = withPdftexShim(normalized);
    const key = crypto.createHash("sha256").update(finalSource).digest("hex");

    const hit = cacheGet(key);
    if (hit) return { pdf: hit.pdf, texErrors: hit.texErrors, ms: Date.now() - started, cached: true };

    await acquire();
    let result;
    try {
        result = await runTectonic(finalSource);
    } finally {
        release();
    }
    await scanForSecrets(result.pdf, userId);
    cachePut(key, result);
    return { pdf: result.pdf, texErrors: result.texErrors, ms: Date.now() - started, cached: false };
};

/** Remove os.tmpdir()/mpc-latex-* directories older than `maxAgeMs`. Returns how many were removed. */
export const sweepLatexTmp = async (maxAgeMs = 3_600_000) => {
    const root = os.tmpdir();
    let removed = 0;
    let entries = [];
    try {
        entries = await readdir(root);
    } catch {
        return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const name of entries) {
        if (!name.startsWith(TMP_PREFIX)) continue;
        const full = path.join(root, name);
        try {
            const info = await stat(full);
            if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
            await rm(full, { recursive: true, force: true });
            removed += 1;
        } catch {
            // vanished or not ours to remove
        }
    }
    return removed;
};

/**
 * Warm-up document: the packages of the Python generator and Jake's template,
 * so Tectonic's bundle cache holds them for offline demos.
 */
export const WARMUP_SOURCE = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage[margin=0.7in]{geometry}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{xcolor}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\input{glyphtounicode}
\pdfgentounicode=1
\pagestyle{fancy}
\fancyhf{}
\titleformat{\section}{\scshape\large}{}{0em}{}[\titlerule]
\begin{document}
\section{Experience}
\begin{itemize}[leftmargin=0.15in]
  \item Built a \textbf{warm-up} document \href{https://example.com}{link} \Letter
\end{itemize}
\begin{tabularx}{\linewidth}{X r}
  Resume Lab & 2026 \\
\end{tabularx}
\end{document}
`;

/** Compile the warm-up document once. Never throws. */
export const warmupLatex = async () => {
    if (!hasTectonic()) return false;
    try {
        await compileLatex(WARMUP_SOURCE, { userId: "warmup" });
        return true;
    } catch (error) {
        console.warn(`[resume-lab] LaTeX warm-up failed: ${error?.message || error}`);
        return false;
    }
};

