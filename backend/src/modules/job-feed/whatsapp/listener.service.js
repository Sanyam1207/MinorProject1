// Reads job posts from WhatsApp channels (docs/contracts/JOB-FEED.md §11). The
// database must already be connected. Runs on its own (`npm run whatsapp` →
// scripts/job-feed-whatsapp.js) or inside the API when WHATSAPP_ENABLED=true.
// Never throws when the optional "baileys" package or the encryption key is
// missing: the status becomes "unavailable" and the API keeps running.
// `onFatal` is called, after the listener has stopped, when it cannot go on
// (for example, WhatsApp logged the device out).
import { getJobFeedConfig } from "../config.js";
import { canEncryptAuthState } from "./auth-state.service.js";
import { loadBaileys } from "./baileys.js";
import { parseChannelList, WhatsAppChannelSource } from "./channel.source.js";
import { loadLlmClient, WhatsAppJobExtractor } from "./job-extractor.service.js";
import { WhatsAppPostService } from "./post.service.js";
import { recordWhatsAppPost, setWhatsAppStatus } from "./status.js";

const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const MAX_AUTOMATIC_ATTEMPTS = 5;
export const BAILEYS_MISSING_REASON = "The optional \"baileys\" package is not installed, so WhatsApp channels are off.";
export const ENCRYPTION_KEY_REASON = "TOKEN_ENCRYPTION_KEY (64 hex chars) is required to store the WhatsApp login.";

const unavailable = (reason, log) => {
    setWhatsAppStatus({ state: "unavailable", reason });
    log.warn(`WhatsApp: ${reason}`);
    return { stop: async () => {}, available: false };
};

/**
 * @param {{onFatal?: (message: string) => void, importBaileys?: () => Promise<object>,
 *   loadLlm?: () => Promise<object>, log?: Console}} [options]
 * @returns {Promise<{stop: () => Promise<void>, available: boolean}>}
 */
export async function startWhatsAppListener({ onFatal = () => {}, importBaileys = undefined, loadLlm = loadLlmClient, log = console } = {}) {
    const config = getJobFeedConfig();
    setWhatsAppStatus({ state: "starting", posts: { saved: 0, ignored: 0, failed: 0 } });

    const lib = await loadBaileys(importBaileys);
    if (!lib) return unavailable(BAILEYS_MISSING_REASON, log);
    if (!canEncryptAuthState()) return unavailable(ENCRYPTION_KEY_REASON, log);

    let llm;
    try {
        llm = await loadLlm();
    } catch (error) {
        llm = { client: null, reason: `the LLM key could not be loaded (${error?.message || error})` };
    }
    log.log(llm.client
        ? `WhatsApp: reading posts with ${llm.description}.`
        : `WhatsApp: reading posts with simple rules, because ${llm.reason}.`);

    const channels = parseChannelList(config.whatsappChannels);
    if (channels.invalid.length) log.warn(`WhatsApp: ignoring these WHATSAPP_CHANNELS entries: ${channels.invalid.join(", ")}`);
    setWhatsAppStatus({
        state: "starting",
        channels: channels.all ? -1 : channels.jids.length + channels.inviteCodes.length,
        extractor: llm.client ? "llm" : "rules",
    });

    const posts = new WhatsAppPostService({ extractor: new WhatsAppJobExtractor({ llmClient: llm.client }) });
    let queue = Promise.resolve();
    let stopped = false;
    let retryTimer = null;

    const logOutcome = (post, result) => {
        if (!result) return;
        recordWhatsAppPost(result.status, post.postedAt);
        const channel = `WhatsApp [${post.channelName || post.channelJid}]`;
        if (result.status === "saved") log.log(`${channel}: found ${result.jobCount} job(s), ${result.newJobCount} new.`);
        else if (result.status === "ignored") log.log(`${channel}: skipped a post. ${result.reason}`);
        else log.error(`${channel}: could not read a post: ${result.error}`);
    };

    const processPost = async (post) => {
        try {
            logOutcome(post, await posts.handle(post));
        } catch (error) {
            log.error("WhatsApp: could not save a post:", error?.message || error);
        }
    };

    // Failed posts get another try in the same queue as new posts, so the LLM is never called twice at once.
    const retryFailedPosts = (options) => {
        queue = queue.then(async () => {
            try {
                const results = await posts.retryFailed(options);
                if (results.length) log.log(`WhatsApp: tried ${results.length} earlier failed post(s) again.`);
                for (const { post, outcome } of results) logOutcome(post, outcome);
            } catch (error) {
                log.error("WhatsApp: could not retry failed posts:", error?.message || error);
            }
        });
    };

    const source = new WhatsAppChannelSource({
        lib,
        channels,
        pairingNumber: config.whatsappPairingNumber,
        log,
        onState: (patch) => {
            if (!stopped) setWhatsAppStatus(patch);
        },
        onPost: (post) => {
            queue = queue.then(() => processPost(post));
        },
        onFatal: (message) => {
            stop(message).then(() => onFatal(message));
        },
    });

    async function stop(reason = null) {
        if (!stopped) {
            stopped = true;
            clearInterval(retryTimer);
            source.stop();
            setWhatsAppStatus({ state: "stopped", reason });
        }
        await queue;
    }

    // A restart usually follows a fix (for example a new model), so every recent failed post gets one more try now.
    retryFailedPosts({});
    retryTimer = setInterval(() => retryFailedPosts({ maxAttempts: MAX_AUTOMATIC_ATTEMPTS }), RETRY_INTERVAL_MS);
    retryTimer.unref?.();
    await source.start();
    return { stop: () => stop(), available: true };
}
