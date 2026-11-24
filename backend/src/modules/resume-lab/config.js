// Resume Lab configuration (docs/contracts/RESUME-BYOK.md §15).
//
// Every getter reads process.env AT CALL TIME so tests (and operators using a
// process manager that reloads env) can change values without re-importing.
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const BUNDLED_TECTONIC = path.join(BACKEND_ROOT, "bin", "tectonic");

const env = (name) => {
    const value = process.env[name];
    return typeof value === "string" ? value.trim() : "";
};

const intEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = env(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const boolEnv = (name, fallback) => {
    const raw = env(name).toLowerCase();
    if (!raw) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return fallback;
};

export const STORAGE_DRIVERS = Object.freeze(["local", "cloudinary", "uploadthing"]);

let warnedDriver = null;
export const storageDriver = () => {
    const raw = env("STORAGE_DRIVER").toLowerCase() || "local";
    if (STORAGE_DRIVERS.includes(raw)) return raw;
    if (warnedDriver !== raw) {
        warnedDriver = raw;
        console.warn(`[resume-lab] unknown STORAGE_DRIVER "${raw}"; using "local"`);
    }
    return "local";
};

export const uploadDir = () => path.resolve(env("UPLOAD_DIR") || "./uploads");

export const cloudinaryConfig = () => ({
    cloudName: env("CLOUDINARY_CLOUD_NAME"),
    apiKey: env("CLOUDINARY_API_KEY"),
    apiSecret: env("CLOUDINARY_API_SECRET"),
    folder: env("CLOUDINARY_RESUME_FOLDER") || "tnp-ai/resumes",
});

export const uploadthingToken = () => env("UPLOADTHING_TOKEN");
export const uploadthingAcl = () => env("UPLOADTHING_ACL") || "private";

export const maxUploadBytes = () => intEnv("RESUME_MAX_UPLOAD_BYTES", 5 * 1024 * 1024, { min: 1 });
export const maxSourceBytes = () => intEnv("RESUME_MAX_SOURCE_BYTES", 200 * 1024, { min: 1 });
export const maxResumesPerUser = () => intEnv("RESUME_MAX_PER_USER", 50, { min: 1 });

/** HMAC secret for signed file links; derived from ACCESS_TOKEN_SECRET when unset. */
export const fileUrlSecret = () => {
    const explicit = env("RESUME_FILE_URL_SECRET");
    if (explicit) return explicit;
    const base = process.env.ACCESS_TOKEN_SECRET || "";
    if (!base) throw new Error("RESUME_FILE_URL_SECRET or ACCESS_TOKEN_SECRET must be set to sign resume links");
    return crypto.createHmac("sha256", base).update("resume-file-url").digest("hex");
};

export const fileUrlTtlSeconds = () => intEnv("RESUME_FILE_URL_TTL_SECONDS", 600, { min: 10, max: 600 });
export const publicApiUrl = () => env("PUBLIC_API_URL").replace(/\/+$/, "");

/** Tectonic binary: TECTONIC_BIN, else backend/bin/tectonic when present, else `tectonic` on PATH. */
export const tectonicBin = () => {
    const explicit = env("TECTONIC_BIN");
    if (explicit) return explicit;
    return existsSync(BUNDLED_TECTONIC) ? BUNDLED_TECTONIC : "tectonic";
};

export const latexCompileTimeoutMs = () => intEnv("LATEX_COMPILE_TIMEOUT_MS", 60_000, { min: 100 });
export const latexMaxConcurrent = () => intEnv("LATEX_MAX_CONCURRENT", 2, { min: 1, max: 32 });
export const latexMaxQueue = () => intEnv("LATEX_MAX_QUEUE", 8, { min: 0, max: 1000 });
export const latexQueueWaitMs = () => intEnv("LATEX_QUEUE_WAIT_MS", 30_000, { min: 1 });
export const latexCacheEntries = () => intEnv("LATEX_CACHE_ENTRIES", 20, { min: 0, max: 500 });
export const latexWarmupOnStart = () => process.env.NODE_ENV !== "test" && boolEnv("LATEX_WARMUP_ON_START", true);

export const EXTRACTED_TEXT_MAX = 100_000;
export const TARGET_JOB_MAX_BYTES = 16 * 1024;
export const LIST_LIMIT = 200;
