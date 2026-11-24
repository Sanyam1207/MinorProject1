import crypto from "crypto";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import {
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_RESUME_FOLDER,
} from "../config/config.js";
import { Resume } from "../models/resume.models.js";
import { ApiError } from "../utils/api-error.js";

const cloudinaryReady = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
if (cloudinaryReady) {
    cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET, secure: true });
}

const hashResume = (latexCode, targetJob) => crypto.createHash("sha256")
    .update(JSON.stringify({ latexCode: latexCode.trim(), targetJob: targetJob || null }))
    .digest("hex");

const compileWith = async (latexCode, command) => {
    try {
        const response = await axios.get("https://latexonline.cc/compile", {
            params: { command, text: latexCode },
            responseType: "arraybuffer",
            timeout: 45000,
            maxContentLength: 10 * 1024 * 1024,
        });
        const buffer = Buffer.from(response.data);
        if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("Compiler did not return a PDF");
        return buffer;
    } catch (error) {
        const details = error.response?.data?.toString?.() || error.message;
        throw new Error(details);
    }
};

const compileLatex = async (latexCode) => {
    const errors = [];
    for (const command of ["pdflatex", "xelatex"]) {
        try {
            return await compileWith(latexCode, command);
        } catch (error) {
            errors.push(`${command}: ${error.message}`);
        }
    }
    const concise = errors.join("\n").split("\n").filter((line) => /error:|undefined control sequence|emergency stop/i.test(line)).slice(0, 4).join(" | ");
    throw new ApiError(422, `The generated LaTeX could not be compiled.${concise ? ` ${concise}` : " Ask the Resume Agent to repair the document."}`);
};

const uploadPdf = (buffer, publicId) => new Promise((resolve, reject) => {
    if (!cloudinaryReady) return reject(new ApiError(503, "Cloudinary resume storage is not configured on the backend"));
    const stream = cloudinary.uploader.upload_stream({
        resource_type: "image",
        type: "authenticated",
        public_id: publicId,
        format: "pdf",
        overwrite: false,
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
});

export const saveGeneratedResume = async ({ user, latexCode, title, targetJob }) => {
    if (!user?.student) throw new ApiError(409, "Complete your student profile before saving a resume");
    if (!cloudinaryReady) throw new ApiError(503, "Cloudinary resume storage is not configured on the backend");
    const cleanLatex = String(latexCode || "").trim();
    if (!cleanLatex || cleanLatex.length > 100000) throw new ApiError(400, "Resume source must contain 1–100000 characters");

    const sourceHash = hashResume(cleanLatex, targetJob);
    const existing = await Resume.findOne({ owner: user._id, sourceHash }).lean();
    if (existing) return { resume: existing, created: false };

    const latest = await Resume.findOne({ owner: user._id }).sort({ version: -1 }).select("version").lean();
    const version = (latest?.version || 0) + 1;
    const safeTitle = String(title || targetJob?.roleTitle || targetJob?.title || "Generated Resume").trim().slice(0, 200);
    const pdf = await compileLatex(cleanLatex);
    const publicId = `${CLOUDINARY_RESUME_FOLDER}/${user._id}/v${version}-${sourceHash.slice(0, 12)}`;
    const upload = await uploadPdf(pdf, publicId);

    try {
        const resume = await Resume.create({
            title: safeTitle,
            latexCode: cleanLatex,
            createdBy: user.student._id || user.student,
            owner: user._id,
            version,
            targetJob: targetJob || null,
            sourceHash,
            storage: {
                publicId: upload.public_id,
                assetId: upload.asset_id || "",
                resourceType: upload.resource_type || "image",
                deliveryType: upload.type || "authenticated",
                format: upload.format || "pdf",
                bytes: upload.bytes || pdf.length,
            },
        });
        return { resume: resume.toObject(), created: true };
    } catch (error) {
        await cloudinary.uploader.destroy(upload.public_id, { resource_type: upload.resource_type || "image", type: upload.type || "authenticated" }).catch(() => {});
        if (error?.code === 11000) {
            const duplicate = await Resume.findOne({ owner: user._id, sourceHash }).lean();
            if (duplicate) return { resume: duplicate, created: false };
        }
        throw error;
    }
};

export const buildPrivateResumeUrl = (resume) => {
    if (!cloudinaryReady) throw new ApiError(503, "Cloudinary resume storage is not configured on the backend");
    return cloudinary.utils.private_download_url(resume.storage.publicId, resume.storage.format || "pdf", {
        resource_type: resume.storage.resourceType || "image",
        type: resume.storage.deliveryType || "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 10 * 60,
        attachment: false,
    });
};

export const listResumeMetadata = async (ownerId) => Resume.find({ owner: ownerId })
    .sort({ version: -1 })
    .select("title version targetJob status createdAt storage.bytes")
    .lean();

export const getLatestResumeForAnalysis = async (ownerId) => Resume.findOne({
    owner: ownerId,
    status: "active",
})
    .sort({ version: -1 })
    .select("title version targetJob latexCode createdAt")
    .lean();
