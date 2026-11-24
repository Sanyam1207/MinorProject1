// WhatsAppPost — every post from an allowed WhatsApp channel and what happened
// to it (docs/contracts/JOB-FEED.md §2.5). Kept for 30 days.
import mongoose from "mongoose";

export const WHATSAPP_POST_TTL_SECONDS = 30 * 24 * 60 * 60;

const whatsAppPostSchema = new mongoose.Schema(
    {
        channelJid: { type: String, required: true },
        channelName: String,
        messageId: { type: String, required: true },
        text: String,
        postedAt: Date,
        status: { type: String, enum: ["saved", "ignored", "failed"], required: true },
        extractedWith: { type: String, enum: ["llm", "rules"] },
        jobCount: { type: Number, default: 0 },
        newJobCount: { type: Number, default: 0 },
        attempts: { type: Number, default: 0 },
        reason: String,
        error: String,
    },
    { timestamps: true, collection: "whatsapp_posts" },
);

whatsAppPostSchema.index({ channelJid: 1, messageId: 1 }, { unique: true });
whatsAppPostSchema.index({ status: 1, postedAt: 1 });
whatsAppPostSchema.index({ createdAt: 1 }, { expireAfterSeconds: WHATSAPP_POST_TTL_SECONDS });

export const WhatsAppPost = mongoose.models.WhatsAppPost || mongoose.model("WhatsAppPost", whatsAppPostSchema);
export default WhatsAppPost;
