// LaTeX layer of the Resume Lab (docs/contracts/RESUME-BYOK.md §6, acceptance tests L1–L6):
// source policy, normalization, the local Tectonic compiler (error mapping, timeouts,
// pdfTeX shim, concurrency) and the secret-exfiltration backstop.
// Tectonic-dependent tests are skipped when the binary is missing.
import "./helpers.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (!process.env.TECTONIC_BIN && existsSync("/opt/homebrew/bin/tectonic")) {
    process.env.TECTONIC_BIN = "/opt/homebrew/bin/tectonic";
}
process.env.LATEX_COMPILE_TIMEOUT_MS = "60000";
process.env.LATEX_MAX_CONCURRENT = "2";
process.env.LATEX_MAX_QUEUE = "8";
delete process.env.RESUME_MAX_SOURCE_BYTES;

const hasTectonic = spawnSync(process.env.TECTONIC_BIN || "tectonic", ["--version"]).status === 0;

const { checkLatexPolicy, assertLatexPolicy, redactSecrets } = await import("../src/modules/resume-lab/latex/policy.js");
const { normalizeLatexSource, withPdftexShim, PDFTEX_SHIM } = await import("../src/modules/resume-lab/latex/normalize.js");
const compiler = await import("../src/modules/resume-lab/latex/compiler.js");
const { compileLatex, _resetLatexCache, sweepLatexTmp, WARMUP_SOURCE } = compiler;

/** Run `fn` with env vars set (undefined deletes), restoring them afterwards. */
const withEnv = async (vars, fn) => {
    const saved = {};
    for (const [key, value] of Object.entries(vars)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = String(value);
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const rejectsWith = async (promise, status, code) => {
    try {
        await promise;
    } catch (error) {
        assert.equal(error.statusCode, status, `expected HTTP ${status}, got ${error.statusCode}: ${error.message}`);
        assert.equal(error.errors?.[0]?.code, code);
        return error;
    }
    assert.fail(`expected ${status} ${code}, but the call succeeded`);
};

const unique = () => `% run ${Date.now()}-${Math.random().toString(36).slice(2)}\n`;
const doc = (body, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

after(() => _resetLatexCache());

describe("L1 source policy rejects file access", () => {
    // The construct sits on line 3 of every sample.
    const PREFIX = "% resume\n% header\n";
    const forbidden = [
        ["\\input{/etc/hosts}", "\\input"],
        ["\\input{../x}", "\\input"],
        ["^^5cinput{/etc/hosts}", "^^"],
        ["\\csname input\\endcsname{/x}", "\\csname"],
        ["\\newread\\f \\openin\\f=/x", "\\newread"],
        ["\\catcode`\\|=0", "\\catcode"],
        ["\\let\\x\\input", "\\input"],
        ["\\begin{filecontents}{a}", "\\begin{filecontents}"],
        ["\\usepackage{../evil}", "\\usepackage"],
        ["\\documentclass{/tmp/x}", "\\documentclass"],
        ["\\includegraphics{/etc/x.png}", "\\includegraphics"],
        ["\\special{x}", "\\special"],
        ["\\XeTeXpicfile", "\\XeTeXpicfile"],
        ["\\immediate\\write18{ls}", "\\immediate"],
        ["\\lstinputlisting{x}", "\\lstinputlisting"],
        ["\\@@input x", "\\@@input"],
        // Hardening beyond the contract's list.
        ["\\let\\x\\input abc \\x{/etc/hosts}", "\\input"],
        ["\\input abc\\x", "\\input"],
        ["\\input /etc/hosts", "\\input"],
        ["\\subimport{a}{b}", "\\subimport"],
        ["\\font\\x=\"[/etc/passwd]\"", "\\font"],
        ["\\setmainfont{X}[Path=/etc/]", "\\setmainfont"],
        ["\\ExplSyntaxOn \\file_input:n {/etc/hosts}", "\\ExplSyntaxOn"],
        ["\\begin{filecontents*}{b}", "\\begin{filecontents*}"],
        ["\\usepackage{amsmath,/etc/x}", "\\usepackage"],
    ];

    for (const [construct, prefix] of forbidden) {
        it(`rejects ${construct}`, () => {
            const result = checkLatexPolicy(`${PREFIX}${construct}\n\\begin{document}\n`);
            assert.equal(result.ok, false);
            assert.equal(result.line, 3);
            assert.ok(result.construct.startsWith(prefix), `construct "${result.construct}" should start with "${prefix}"`);
            assert.throws(() => assertLatexPolicy(`${PREFIX}${construct}`), (error) => {
                assert.equal(error.statusCode, 422);
                assert.equal(error.errors[0].code, "LATEX_FORBIDDEN");
                assert.equal(error.errors[0].line, 3);
                assert.match(error.message, /^For security, `.+` is not allowed \(line 3\)\. Remove it and compile again\.$/);
                return true;
            });
        });
    }

    it("compileLatex applies the policy before running Tectonic (even without a binary)", async () => {
        await withEnv({ TECTONIC_BIN: "/nonexistent/tectonic" }, async () => {
            const error = await rejectsWith(compileLatex(doc("\\input{/etc/hosts}")), 422, "LATEX_FORBIDDEN");
            assert.equal(error.errors[0].line, 3);
            assert.equal(error.errors[0].construct, "\\input{/etc/hosts}");
        });
    });

    it("reports the earliest violation", () => {
        const result = checkLatexPolicy("ok\n\\special{a}\n\\input{/x}\n");
        assert.deepEqual(result, { ok: false, construct: "\\special", line: 2 });
    });
});

describe("L2 source policy allows normal resumes", () => {
    const allowed = [
        "\\input{glyphtounicode}",
        "\\usepackage[hidelinks]{hyperref}",
        "\\usepackage[utf8]{inputenc}",
        "\\usepackage{amsmath, amssymb}",
        "\\makeatletter",
        "\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-2pt}}}}",
        "\\pdfgentounicode=1",
        "\\input glyphtounicode\n",
        "\\includegraphics[width=2cm]{photo.png}",
        "\\documentclass[letterpaper,11pt]{article}",
        "line\\\\Next",
        "Improved throughput by 30\\%",
        "\\setmainfont{Latin Modern Roman}",
    ];
    for (const source of allowed) {
        it(`allows ${JSON.stringify(source)}`, () => {
            assert.deepEqual(checkLatexPolicy(source), { ok: true });
            assert.doesNotThrow(() => assertLatexPolicy(source));
        });
    }

    it("allows the warm-up document (all generator and Jake packages)", () => {
        assert.deepEqual(checkLatexPolicy(WARMUP_SOURCE), { ok: true });
    });
});

describe("normalization (§6.2)", () => {
    it("normalizes CRLF and strips code fences", () => {
        assert.equal(normalizeLatexSource("```latex\r\n\\documentclass{article}\r\nx\r\n```"), "\\documentclass{article}\nx");
        assert.equal(normalizeLatexSource("```\nA\n```\n"), "A");
    });

    it("removes the pdftex option from hyperref only", () => {
        assert.equal(
            normalizeLatexSource("\\usepackage[pdftex,hidelinks]{hyperref}\n\\usepackage[pdftex]{graphicx}"),
            "\\usepackage[hidelinks]{hyperref}\n\\usepackage[pdftex]{graphicx}",
        );
    });

    it("prepends the shim to line 1 without a newline", () => {
        const shimmed = withPdftexShim("\\documentclass{article}\nx");
        assert.ok(shimmed.startsWith(PDFTEX_SHIM));
        assert.equal(shimmed.split("\n").length, 2);
        assert.ok(!PDFTEX_SHIM.includes("\n"));
    });
});

describe("L6 over-escaped normalization", () => {
    it("leaves `\\\\` line breaks alone in normal sources", () => {
        const source = "\\documentclass{article}\n\\begin{document}\nline\\\\Next\n\\end{document}\n";
        assert.equal(normalizeLatexSource(source), source);
        assert.equal(normalizeLatexSource("line\\\\Next"), "line\\\\Next");
    });

    it("de-escapes doubled backslashes and literal \\n in over-escaped sources", () => {
        const overEscaped = "\\\\documentclass{article}\\n\\\\begin{document}\\n\\\\textbf{x}\\n\\\\end{document}\\n";
        assert.equal(
            normalizeLatexSource(overEscaped),
            "\\documentclass{article}\n\\begin{document}\n\\textbf{x}\n\\end{document}\n",
        );
    });

    it("compiles an over-escaped document", { skip: !hasTectonic }, async () => {
        const overEscaped = `${unique()}\\\\documentclass{article}\n\\\\begin{document}\n\\\\textbf{x}\n\\\\end{document}\n`;
        const result = await compileLatex(overEscaped);
        assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    });
});

describe("L3 Tectonic compile", { skip: !hasTectonic }, () => {
    it("compiles a minimal document to a PDF and caches it", async () => {
        _resetLatexCache();
        const source = `${unique()}${doc("Hello Resume Lab")}`;
        const first = await compileLatex(source);
        assert.equal(first.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
        assert.equal(first.cached, false);
        assert.equal(first.texErrors, 0);
        assert.equal(typeof first.ms, "number");
        const second = await compileLatex(source);
        assert.equal(second.cached, true);
        assert.ok(second.pdf.equals(first.pdf));
    });

    it("compiles a Jake-style preamble thanks to the pdfTeX shim", async () => {
        const source = `${unique()}\\documentclass[letterpaper,11pt]{article}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\input{glyphtounicode}
\\pdfgentounicode=1
\\begin{document}
\\section{Experience}
\\begin{itemize}
\\item Built a resume compiler
\\end{itemize}
\\end{document}
`;
        const result = await compileLatex(source);
        assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    });

    it("reports errors[0].line equal to the user's line", async () => {
        // Line 4 references a missing file: a fatal TeX error.
        const source = "\\documentclass{article}\n\\begin{document}\nHello\n\\input{nonexistentfilexyz}\nWorld\n\\end{document}\n";
        const error = await rejectsWith(compileLatex(source), 422, "LATEX_COMPILE_FAILED");
        assert.equal(error.errors[0].line, 4);
        assert.ok(error.errors[0].log.length > 0 && error.errors[0].log.length <= 1500);
        assert.ok(error.errors[0].log.split("\n").length <= 8);
        assert.ok(!error.errors[0].log.includes("mpc-latex-"), "temp paths are hidden");
        assert.ok(!error.errors[0].log.includes(os.tmpdir()), "temp paths are hidden");
    });

    it("counts recoverable TeX errors (continue-on-errors) instead of failing", async () => {
        const result = await compileLatex(`${unique()}${doc("Hello\n\\undefinedmacro\nWorld")}`);
        assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
        assert.ok(result.texErrors >= 1);
    });

    it("a document without \\end{document} fails with 422", async () => {
        const error = await rejectsWith(compileLatex("\\documentclass{article}\n\\begin{document}\nHi\n"), 422, "LATEX_COMPILE_FAILED");
        assert.equal(typeof error.errors[0].log, "string");
    });
});

describe("L4 compiler availability and timeouts", () => {
    it("TECTONIC_BIN=/nonexistent → 503 COMPILER_UNAVAILABLE", async () => {
        _resetLatexCache();
        await withEnv({ TECTONIC_BIN: "/nonexistent" }, async () => {
            assert.equal(compiler.hasTectonic(), false);
            await rejectsWith(compileLatex(`${unique()}${doc("x")}`), 503, "COMPILER_UNAVAILABLE");
        });
    });

    it("an endless loop is stopped → 504 LATEX_COMPILE_TIMEOUT", { skip: !hasTectonic }, async () => {
        await withEnv({ LATEX_COMPILE_TIMEOUT_MS: "1500" }, async () => {
            const started = Date.now();
            await rejectsWith(compileLatex(`${unique()}${doc("\\loop\\iftrue\\repeat")}`), 504, "LATEX_COMPILE_TIMEOUT");
            assert.ok(Date.now() - started < 15_000);
        });
    });

    it("an offline bundle download maps to 503 COMPILER_UNAVAILABLE", { skip: !hasTectonic }, async () => {
        // Empty cache + unreachable proxy: Tectonic cannot fetch its bundle (no real network is used).
        const emptyCache = path.join(os.tmpdir(), `mpc-test-empty-cache-${process.pid}`);
        await mkdir(emptyCache, { recursive: true });
        await withEnv({
            HOME: emptyCache,
            XDG_CACHE_HOME: emptyCache,
            TECTONIC_CACHE_DIR: emptyCache,
            HTTPS_PROXY: "http://127.0.0.1:9",
            HTTP_PROXY: "http://127.0.0.1:9",
            NO_PROXY: undefined,
        }, async () => {
            const error = await rejectsWith(compileLatex(`${unique()}${doc("offline")}`), 503, "COMPILER_UNAVAILABLE");
            assert.match(error.message, /offline/);
        }).finally(() => rm(emptyCache, { recursive: true, force: true }));
    });

    it("empty source → 400 VALIDATION; oversized source → 413 SOURCE_TOO_LARGE", async () => {
        await rejectsWith(compileLatex("   \n"), 400, "VALIDATION");
        await rejectsWith(compileLatex(undefined), 400, "VALIDATION");
        await withEnv({ RESUME_MAX_SOURCE_BYTES: "100" }, async () => {
            await rejectsWith(compileLatex(doc("x".repeat(200))), 413, "SOURCE_TOO_LARGE");
        });
    });

    it("a full queue answers 429 COMPILER_BUSY", { skip: !hasTectonic }, async () => {
        await withEnv({ LATEX_MAX_CONCURRENT: "1", LATEX_MAX_QUEUE: "0" }, async () => {
            const results = await Promise.allSettled([
                compileLatex(`${unique()}${doc("first")}`),
                compileLatex(`${unique()}${doc("second")}`),
            ]);
            assert.equal(results[0].status, "fulfilled");
            assert.equal(results[1].status, "rejected");
            assert.equal(results[1].reason.statusCode, 429);
            assert.equal(results[1].reason.errors[0].code, "COMPILER_BUSY");
        });
        // The slot is released: compiling works again.
        const again = await compileLatex(`${unique()}${doc("third")}`);
        assert.equal(again.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    });

    it("queued compiles wait for a slot", { skip: !hasTectonic }, async () => {
        await withEnv({ LATEX_MAX_CONCURRENT: "1", LATEX_MAX_QUEUE: "4" }, async () => {
            const results = await Promise.all([1, 2, 3].map((n) => compileLatex(`${unique()}${doc(`queued ${n}`)}`)));
            for (const result of results) assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
        });
    });
});

describe("L5 secret exfiltration backstop", () => {
    const SECRET = "abcdefghijklmnop1234";

    it("redactSecrets replaces secret env values", async () => {
        await withEnv({ TEST_SECRET: SECRET }, async () => {
            assert.equal(redactSecrets(`value=${SECRET}!`), "value=[redacted]!");
        });
    });

    it("a PDF that prints a secret env value is discarded → 422 LATEX_FORBIDDEN secret", { skip: !hasTectonic }, async () => {
        await withEnv({ TEST_SECRET: SECRET }, async () => {
            const error = await rejectsWith(compileLatex(`${unique()}${doc(`Key:\n\n${SECRET}\n`)}`, { userId: "u1" }), 422, "LATEX_FORBIDDEN");
            assert.equal(error.errors[0].construct, "secret");
            const body = JSON.stringify({ message: error.message, errors: error.errors, data: error.data });
            assert.ok(!body.includes(SECRET), "the secret never appears in the response");
        });
    });

    it("secret values are redacted from compile logs", { skip: !hasTectonic }, async () => {
        await withEnv({ TEST_SECRET: SECRET }, async () => {
            const error = await rejectsWith(compileLatex(doc(`\\input{${SECRET}}`)), 422, "LATEX_COMPILE_FAILED");
            const body = JSON.stringify({ message: error.message, errors: error.errors });
            assert.ok(!body.includes(SECRET));
            assert.ok(error.errors[0].log.includes("[redacted]"));
        });
    });

    it("the child process gets only the allowlisted environment", { skip: !hasTectonic }, async () => {
        // A secret in the server env is not reachable from TeX: compiling still works and the
        // secret scan passes for a document that does not print it.
        await withEnv({ TEST_SECRET: SECRET }, async () => {
            const result = await compileLatex(`${unique()}${doc("No secrets here")}`);
            assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
        });
    });
});

describe("maintenance helpers", () => {
    it("sweepLatexTmp removes stale mpc-latex-* directories only", async () => {
        const stale = path.join(os.tmpdir(), `mpc-latex-teststale${process.pid}`);
        const fresh = path.join(os.tmpdir(), `mpc-latex-testfresh${process.pid}`);
        await mkdir(stale, { recursive: true });
        await mkdir(fresh, { recursive: true });
        const old = new Date(Date.now() - 2 * 3_600_000);
        await utimes(stale, old, old);
        const removed = await sweepLatexTmp(3_600_000);
        assert.ok(removed >= 1);
        assert.equal(existsSync(stale), false);
        assert.equal(existsSync(fresh), true);
        await rm(fresh, { recursive: true, force: true });
    });

    it("warmupLatex never throws", async () => {
        await withEnv({ TECTONIC_BIN: "/nonexistent" }, async () => {
            assert.equal(await compiler.warmupLatex(), false);
        });
    });
});
