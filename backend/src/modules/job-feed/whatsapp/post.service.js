// Turns WhatsApp channel posts into feed jobs, once per post (docs/contracts/JOB-FEED.md §11.2).
// Ported from Matchy's whatsapp-post.service.js.
import { WHATSAPP_SOURCE } from "../constants.js";
import { WhatsAppPost } from "../models/whatsapp-post.model.js";
import { emitToRoles, jobSyncService } from "../sync.service.js";

export { WHATSAPP_SOURCE };
// Failed posts are retried while they are still fresh, matching the listener's 3-day limit for new posts.
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export class WhatsAppPostService {
    constructor({ extractor, jobs = jobSyncService }) {
        this.extractor = extractor;
        this.jobs = jobs;
    }

    // Turns one channel post into jobs. Posts that were already handled are skipped; failed ones are tried again.
    async handle(post) {
        const key = { channelJid: post.channelJid, messageId: post.messageId };
        if (await WhatsAppPost.exists({ ...key, status: { $ne: "failed" } })) return null;

        let outcome;
        try {
            const { jobs, extractedWith, reason } = await this.extractor.extract(post.text);
            const stats = jobs.length
                ? await this.jobs.ingest(WHATSAPP_SOURCE, jobs.map((job, index) => ({
                    ...job,
                    externalId: `${post.channelJid}:${post.messageId}:${index}`,
                    description: post.text,
                    postedAt: post.postedAt,
                })))
                : null;
            outcome = {
                status: jobs.length ? "saved" : "ignored",
                extractedWith: extractedWith ?? undefined,
                jobCount: jobs.length,
                newJobCount: stats?.inserted ?? 0,
                reason: jobs.length ? undefined : reason,
            };
        } catch (error) {
            outcome = { status: "failed", jobCount: 0, newJobCount: 0, error: error?.message || "The post could not be processed." };
        }

        // A post that failed before and works now must lose its old error, so empty fields are unset.
        const fields = { extractedWith: undefined, reason: undefined, error: undefined, ...outcome, channelName: post.channelName, text: post.text, postedAt: post.postedAt };
        const entries = Object.entries(fields);
        const update = { $set: Object.fromEntries(entries.filter(([, value]) => value !== undefined)), $inc: { attempts: 1 } };
        const emptyFields = entries.filter(([, value]) => value === undefined).map(([field]) => [field, ""]);
        if (emptyFields.length) update.$unset = Object.fromEntries(emptyFields);
        await WhatsAppPost.updateOne(key, update, { upsert: true });

        if (outcome.newJobCount > 0) {
            emitToRoles(["student", "tpo", "admin"], "job-feed:updated", {
                inserted: outcome.newJobCount,
                source: "whatsapp",
                at: new Date(),
            });
        }
        return outcome;
    }

    // Runs failed posts from the last few days through extraction again, oldest first.
    async retryFailed({ maxAttempts = Infinity, now = new Date() } = {}) {
        const filter = { status: "failed", postedAt: { $gte: new Date(now.getTime() - RETRY_WINDOW_MS) } };
        if (Number.isFinite(maxAttempts)) filter.$or = [{ attempts: { $lt: maxAttempts } }, { attempts: { $exists: false } }];

        const results = [];
        for (const post of await WhatsAppPost.find(filter).sort({ postedAt: 1 })) {
            const outcome = await this.handle({
                channelJid: post.channelJid,
                channelName: post.channelName,
                messageId: post.messageId,
                text: post.text,
                postedAt: post.postedAt,
            });
            results.push({ post, outcome });
        }
        return results;
    }
}
