// UploadThing driver (RESUME-BYOK.md §3) — port of Matchy's
// UploadThingResumeStorage with a private ACL and signed reads. Never builds
// public `https://utfs.io/f/<key>` URLs.
import { fail } from "../../../core/http.js";
import { uploadthingAcl, uploadthingToken } from "../config.js";

let api = null;
let apiToken = null;

const client = async () => {
    const token = uploadthingToken();
    if (!token) {
        throw fail(503, "UploadThing resume storage is not configured on this server", "STORAGE_UNAVAILABLE", { driver: "uploadthing" });
    }
    if (!api || apiToken !== token) {
        const { UTApi } = await import("uploadthing/server");
        api = new UTApi({ token });
        apiToken = token;
    }
    return api;
};

const unavailable = (action, error) =>
    fail(503, `UploadThing ${action} failed: ${error?.message || "unknown error"}`, "STORAGE_UNAVAILABLE", { driver: "uploadthing" });

export const uploadthingDriver = {
    name: "uploadthing",
    isConfigured: () => Boolean(uploadthingToken()),

    async put(key, buffer, { contentType, originalName } = {}) {
        const utapi = await client();
        const { UTFile } = await import("uploadthing/server");
        const name = String(key).split("/").pop() || "resume.bin";
        const file = new UTFile([buffer], name, { type: contentType || "application/octet-stream" });
        let result;
        try {
            result = await utapi.uploadFiles(file, { acl: uploadthingAcl() });
        } catch (error) {
            throw unavailable("upload", error);
        }
        if (result?.error || !result?.data?.key) throw unavailable("upload", result?.error || new Error("no file key returned"));
        return {
            driver: "uploadthing",
            key: result.data.key,
            contentType: contentType || "application/octet-stream",
            bytes: buffer.length,
            ...(originalName ? { originalName } : {}),
            meta: { name },
        };
    },

    async signedUrl(storedFile, { expiresInSeconds = 60 } = {}) {
        const utapi = await client();
        try {
            const { ufsUrl } = await utapi.generateSignedURL(storedFile.key, { expiresIn: Math.max(10, expiresInSeconds) });
            return ufsUrl;
        } catch (error) {
            throw unavailable("signing", error);
        }
    },

    async get(storedFile) {
        const url = await this.signedUrl(storedFile, { expiresInSeconds: 60 });
        const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((error) => {
            throw unavailable("download", error);
        });
        if (response.status === 404) throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
        if (!response.ok) throw unavailable("download", new Error(`HTTP ${response.status}`));
        return Buffer.from(await response.arrayBuffer());
    },

    async delete(storedFile) {
        if (!storedFile?.key) return;
        const utapi = await client();
        await utapi.deleteFiles(storedFile.key);
    },
};
