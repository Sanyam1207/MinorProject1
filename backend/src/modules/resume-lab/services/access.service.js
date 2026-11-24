// Signed resume file links and file delivery (docs/contracts/RESUME-BYOK.md §8.4).
//
//   signResumeLink(resume, {viewerId, variant, ttlSeconds}) → {url, expiresAt, variant}   (sync)
//   verifyResumeSignature({resumeId, variant, exp, viewer, sig})                          (throws 403)
//   buildResumeAccessUrl(resume, {viewerId, variant}) → Promise<{url, expiresAt, variant, kind}>
//   sendResumeFile(res, resume, {variant, download, userId})
//
// sig = base64url(HMAC_SHA256(RESUME_FILE_URL_SECRET, `${resumeId}|${variant}|${exp}|${viewerId}`))
import crypto from "node:crypto";
import { fail } from "../../../core/http.js";
import { fileUrlSecret, fileUrlTtlSeconds, publicApiUrl } from "../config.js";
import { storageFor } from "../storage/index.js";
import { getCompiledPdf } from "./resume.service.js";

export const VARIANTS = Object.freeze(["pdf", "original"]);
const kindOf = (resume) => resume?.kind || "latex";

/** `pdf` for latex/pdf resumes, `original` otherwise. */
export const defaultVariant = (resume) => (["latex", "pdf"].includes(kindOf(resume)) ? "pdf" : "original");

export const normalizeVariant = (value, resume) => {
    if (value === undefined || value === null || value === "") return defaultVariant(resume);
    const variant = String(value).toLowerCase();
    if (!VARIANTS.includes(variant)) throw fail(400, "variant must be pdf or original", "VALIDATION", { field: "variant" });
    return variant;
};

const signature = (resumeId, variant, exp, viewer) => crypto
    .createHmac("sha256", fileUrlSecret())
    .update(`${resumeId}|${variant}|${exp}|${viewer}`)
    .digest("base64url");

/** Signed link to `/api/v1/resumes/:id/file` (synchronous; no compile). */
export const signResumeLink = (resume, { viewerId = null, variant, ttlSeconds = fileUrlTtlSeconds() } = {}) => {
    const resumeId = String(resume._id ?? resume.id);
    const chosen = normalizeVariant(variant, resume);
    const ttl = Math.max(1, Math.min(Number(ttlSeconds) || fileUrlTtlSeconds(), fileUrlTtlSeconds()));
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const viewer = viewerId ? String(viewerId) : "-";
    const sig = signature(resumeId, chosen, exp, viewer);
    const query = new URLSearchParams({ variant: chosen, exp: String(exp), viewer, sig });
    return {
        url: `${publicApiUrl()}/api/v1/resumes/${resumeId}/file?${query.toString()}`,
        expiresAt: new Date(exp * 1000).toISOString(),
        variant: chosen,
    };
};

/**
 * SIH-compatible helper (placements `GET /applications/:id/resume`): a signed
 * link STRING, returned synchronously. No compile happens here; a stale latex
 * PDF is compiled when the link is fetched. Variant: pdf for latex/pdf, else original.
 */
export const buildPrivateResumeUrl = (resume, { viewerId = null } = {}) =>
    signResumeLink(resume, { viewerId, variant: defaultVariant(resume) }).url;

/** Verify a signed link; throws 403 INVALID_SIGNATURE / LINK_EXPIRED. */
export const verifyResumeSignature = ({ resumeId, variant, exp, viewer, sig }) => {
    const expected = Buffer.from(signature(String(resumeId), String(variant ?? ""), String(exp ?? ""), String(viewer ?? "")));
    const given = Buffer.from(String(sig ?? ""));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        throw fail(403, "This file link is invalid", "INVALID_SIGNATURE");
    }
    const expiry = Number(exp);
    if (!Number.isFinite(expiry) || expiry * 1000 <= Date.now()) {
        throw fail(403, "This file link has expired. Open the resume again to get a new link.", "LINK_EXPIRED");
    }
};

/**
 * Signed link after making sure the file exists: a latex PDF that is missing or
 * stale is compiled (and stored) first, so compile errors reach the caller.
 * The caller authorizes the viewer.
 */
export const buildResumeAccessUrl = async (resume, { viewerId = null, variant } = {}) => {
    const chosen = normalizeVariant(variant, resume);
    const kind = kindOf(resume);
    if (chosen === "pdf" && (kind === "docx" || kind === "text")) {
        throw fail(409, "This resume has no PDF version. Open the original file instead.", "NO_PDF");
    }
    if (chosen === "pdf" && kind === "latex") await getCompiledPdf(resume, { userId: viewerId, wantBuffer: false });
    if ((kind === "pdf" || kind === "docx") && !resume.original?.key) {
        throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
    }
    return { ...signResumeLink(resume, { viewerId, variant: chosen }), kind };
};

const asciiFilename = (title, extension) => {
    const base = String(title || "resume")
        .normalize("NFKD")
        .replace(/[^\x20-\x7e]/g, "")
        .replace(/["\\/:*?<>|;]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100) || "resume";
    return `${base}.${extension}`;
};

const contentDisposition = (title, extension, download) => {
    const ascii = asciiFilename(title, extension);
    const utf8 = `${String(title || "resume").replace(/[\r\n"]/g, " ").slice(0, 150)}.${extension}`;
    return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
};

const setFileHeaders = (res, { contentType, title, extension, download }) => {
    res.set({
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(title, extension, download),
    });
};

const deliverStored = async (res, storedFile, { contentType, title, extension, download }) => {
    const driver = storageFor(storedFile);
    if (typeof driver.signedUrl === "function") {
        const url = await driver.signedUrl(storedFile, { expiresInSeconds: 60, download, filename: asciiFilename(title, extension) });
        res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        return res.redirect(302, url);
    }
    setFileHeaders(res, { contentType, title, extension, download });
    if (typeof driver.stream === "function") {
        const { stream, bytes } = await driver.stream(storedFile);
        res.set("Content-Length", String(bytes));
        return new Promise((resolve, reject) => {
            stream.on("error", reject);
            res.on("finish", resolve);
            res.on("close", resolve);
            stream.pipe(res);
        });
    }
    return res.send(await driver.get(storedFile));
};

/** Send a resume's file for `variant` (see the §8.4 table). `resume` must include +source. */
export const sendResumeFile = async (res, resume, { variant, download = false, userId = null } = {}) => {
    const kind = kindOf(resume);
    const chosen = normalizeVariant(variant, resume);
    const title = resume.title;

    if (chosen === "pdf") {
        if (kind === "docx" || kind === "text") throw fail(409, "This resume has no PDF version. Open the original file instead.", "NO_PDF");
        if (kind === "pdf") {
            if (!resume.original?.key) throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
            return deliverStored(res, resume.original, { contentType: "application/pdf", title, extension: "pdf", download });
        }
        const compiled = await getCompiledPdf(resume, { userId, wantBuffer: false });
        if (compiled.cached && compiled.stored) {
            try {
                return await deliverStored(res, compiled.stored, { contentType: "application/pdf", title, extension: "pdf", download });
            } catch (error) {
                if (res.headersSent) throw error;
                console.warn(`[resume-lab] cached PDF unreadable, recompiling: ${error?.message || error}`);
            }
        }
        const fresh = compiled.buffer ? compiled : await getCompiledPdf({ ...resume, pdf: null }, { userId });
        setFileHeaders(res, { contentType: "application/pdf", title, extension: "pdf", download });
        return res.send(fresh.buffer);
    }

    if (kind === "latex" || kind === "text") {
        const extension = kind === "latex" ? "tex" : "txt";
        const contentType = kind === "latex" ? "application/x-tex; charset=utf-8" : "text/plain; charset=utf-8";
        setFileHeaders(res, { contentType, title, extension, download });
        return res.send(Buffer.from(resume.source ?? "", "utf8"));
    }
    if (!resume.original?.key) throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
    const extension = kind === "pdf" ? "pdf" : "docx";
    const contentType = kind === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return deliverStored(res, resume.original, { contentType, title, extension, download });
};
