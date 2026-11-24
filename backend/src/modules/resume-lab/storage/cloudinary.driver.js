// Cloudinary driver (RESUME-BYOK.md §3) — port of the SIH Resume Bank code.
// Files are `authenticated` (private); reads go through short-lived signed
// private-download URLs. Configuration is read at call time.
import crypto from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { fail } from "../../../core/http.js";
import { cloudinaryConfig } from "../config.js";

let configuredWith = null;

const client = () => {
    const config = cloudinaryConfig();
    if (!config.cloudName || !config.apiKey || !config.apiSecret) {
        throw fail(503, "Cloudinary resume storage is not configured on this server", "STORAGE_UNAVAILABLE", { driver: "cloudinary" });
    }
    const signature = `${config.cloudName}|${config.apiKey}|${crypto.createHash("sha256").update(config.apiSecret).digest("hex")}`;
    if (configuredWith !== signature) {
        cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true });
        configuredWith = signature;
    }
    return { cloudinary, config };
};

const isPdf = (contentType, key) => contentType === "application/pdf" || /\.pdf$/i.test(String(key || ""));

// Resource coordinates of a stored file. Legacy SIH PDFs keep theirs in meta.
const coordinates = (storedFile) => {
    const meta = storedFile.meta || {};
    const pdf = isPdf(storedFile.contentType, storedFile.key);
    return {
        publicId: storedFile.key,
        resourceType: meta.resourceType || (pdf ? "image" : "raw"),
        deliveryType: meta.deliveryType || "authenticated",
        format: meta.format || (pdf ? "pdf" : ""),
    };
};

export const cloudinaryDriver = {
    name: "cloudinary",

    isConfigured() {
        const config = cloudinaryConfig();
        return Boolean(config.cloudName && config.apiKey && config.apiSecret);
    },

    async put(key, buffer, { contentType, originalName } = {}) {
        const { cloudinary: api, config } = client();
        const pdf = isPdf(contentType, key);
        // key = resumes/<ownerId>/<name>.<ext> → public id <folder>/<ownerId>/<name>
        const segments = String(key).split("/");
        const ownerSegment = segments.length >= 3 ? segments[segments.length - 2] : "misc";
        const baseName = segments[segments.length - 1].replace(/\.[A-Za-z0-9]+$/, "") || crypto.randomUUID();
        const publicId = `${config.folder}/${ownerSegment}/${pdf ? baseName : `${baseName}.${(key.match(/\.([A-Za-z0-9]+)$/) || [])[1] || "bin"}`}`;
        const result = await new Promise((resolve, reject) => {
            const stream = api.uploader.upload_stream({
                resource_type: pdf ? "image" : "raw",
                type: "authenticated",
                public_id: publicId,
                ...(pdf ? { format: "pdf" } : {}),
                overwrite: false,
            }, (error, uploaded) => (error ? reject(error) : resolve(uploaded)));
            stream.end(buffer);
        }).catch((error) => {
            throw fail(503, `Cloudinary upload failed: ${error?.message || "unknown error"}`, "STORAGE_UNAVAILABLE", { driver: "cloudinary" });
        });
        return {
            driver: "cloudinary",
            key: result.public_id,
            contentType: contentType || "application/octet-stream",
            bytes: result.bytes || buffer.length,
            ...(originalName ? { originalName } : {}),
            meta: {
                resourceType: result.resource_type || (pdf ? "image" : "raw"),
                deliveryType: result.type || "authenticated",
                format: result.format || (pdf ? "pdf" : ""),
                assetId: result.asset_id || "",
            },
        };
    },

    signedUrl(storedFile, { expiresInSeconds = 60, download = false } = {}) {
        const { cloudinary: api } = client();
        const coords = coordinates(storedFile);
        return api.utils.private_download_url(coords.publicId, coords.format, {
            resource_type: coords.resourceType,
            type: coords.deliveryType,
            expires_at: Math.floor(Date.now() / 1000) + Math.max(10, expiresInSeconds),
            attachment: Boolean(download),
        });
    },

    async get(storedFile) {
        const url = this.signedUrl(storedFile, { expiresInSeconds: 60 });
        const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((error) => {
            throw fail(503, `Cloudinary download failed: ${error?.message || "network error"}`, "STORAGE_UNAVAILABLE", { driver: "cloudinary" });
        });
        if (response.status === 404) throw fail(404, "The stored file is missing", "NOT_FOUND", { entity: "file" });
        if (!response.ok) throw fail(503, `Cloudinary download failed (${response.status})`, "STORAGE_UNAVAILABLE", { driver: "cloudinary" });
        return Buffer.from(await response.arrayBuffer());
    },

    async delete(storedFile) {
        if (!storedFile?.key) return;
        const { cloudinary: api } = client();
        const coords = coordinates(storedFile);
        const result = await api.uploader.destroy(coords.publicId, { resource_type: coords.resourceType, type: coords.deliveryType });
        if (result?.result && !["ok", "not found"].includes(result.result)) {
            throw new Error(`Cloudinary destroy answered "${result.result}"`);
        }
    },
};
