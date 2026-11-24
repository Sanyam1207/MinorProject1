// Local filesystem driver (RESUME-BYOK.md §3). Files live under UPLOAD_DIR
// (resolved at call time), are created with mode 0600 and are only ever
// streamed by Node after an owner-JWT or HMAC-signed-link check.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fail } from "../../../core/http.js";
import { uploadDir } from "../config.js";

/** Resolve `key` under the upload root, refusing anything that escapes it. */
export const resolveLocalPath = (key) => {
    const root = uploadDir();
    const normalizedKey = String(key || "");
    if (!normalizedKey || normalizedKey.includes("\0") || path.isAbsolute(normalizedKey)) {
        throw fail(400, "Invalid file key", "VALIDATION", { field: "key" });
    }
    const target = path.resolve(root, normalizedKey);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw fail(400, "Invalid file key", "VALIDATION", { field: "key" });
    }
    return target;
};

const isNotFound = (error) => error?.code === "ENOENT";

export const localDriver = {
    name: "local",
    isConfigured: () => true,

    async put(key, buffer, { contentType, originalName } = {}) {
        const target = resolveLocalPath(key);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, buffer, { mode: 0o600 });
        return {
            driver: "local",
            key,
            contentType: contentType || "application/octet-stream",
            bytes: buffer.length,
            ...(originalName ? { originalName } : {}),
        };
    },

    async get(storedFile) {
        try {
            return await readFile(resolveLocalPath(storedFile.key));
        } catch (error) {
            if (isNotFound(error)) throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
            throw error;
        }
    },

    /** `{stream, bytes}` for the file (rejects with 404 when it is missing). */
    async stream(storedFile) {
        const target = resolveLocalPath(storedFile.key);
        const info = await stat(target).catch((error) => {
            if (isNotFound(error)) throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
            throw error;
        });
        return { stream: createReadStream(target), bytes: info.size };
    },

    async delete(storedFile) {
        if (!storedFile?.key) return;
        await rm(resolveLocalPath(storedFile.key), { force: true });
    },
};
