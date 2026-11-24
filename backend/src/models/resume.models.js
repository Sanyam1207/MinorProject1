import mongoose, { Schema } from "mongoose";

const resumeSchema = new Schema({
    title: { type: String, required: true, trim: true, maxlength: 200 },
    latexCode: { type: String, required: true, maxlength: 100000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    version: { type: Number, required: true, min: 1 },
    targetJob: { type: Schema.Types.Mixed, default: null },
    sourceHash: { type: String, required: true },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    storage: {
        provider: { type: String, enum: ["cloudinary"], default: "cloudinary" },
        publicId: { type: String, required: true },
        assetId: { type: String, default: "" },
        resourceType: { type: String, default: "image" },
        deliveryType: { type: String, default: "authenticated" },
        format: { type: String, default: "pdf" },
        bytes: { type: Number, default: 0 },
    },
}, { timestamps: true });

resumeSchema.index({ owner: 1, version: 1 }, { unique: true, partialFilterExpression: { owner: { $exists: true } } });
resumeSchema.index({ owner: 1, sourceHash: 1 }, { unique: true, partialFilterExpression: { owner: { $exists: true } } });

export const Resume = mongoose.models.Resume || mongoose.model("Resume", resumeSchema);
