// In-process status of the WhatsApp listener (docs/contracts/JOB-FEED.md §11.4).
// Imported by routes and the feed service; never imports baileys. Never holds
// the phone number, account name, QR code or keys.
import { getJobFeedConfig } from "../config.js";

export const WHATSAPP_STATES = Object.freeze([
    "disabled", "unavailable", "starting", "waiting-for-link", "connected", "reconnecting", "stopped",
]);

const initialState = () => ({
    started: false,
    state: "disabled",
    reason: null,
    channels: 0,
    extractor: null,
    lastPostAt: null,
    posts: { saved: 0, ignored: 0, failed: 0 },
});

let current = initialState();

/**
 * @returns {{enabled: boolean, state: string, reason: string|null, channels: number,
 *   extractor: "llm"|"rules"|null, lastPostAt: Date|null, posts: {saved: number, ignored: number, failed: number}}}
 */
export const getWhatsAppStatus = () => ({
    enabled: getJobFeedConfig().whatsappEnabled || current.started,
    state: current.state,
    reason: current.reason,
    channels: current.channels,
    extractor: current.extractor,
    lastPostAt: current.lastPostAt,
    posts: { ...current.posts },
});

/** Merge a partial update. `state` must be one of WHATSAPP_STATES. */
export const setWhatsAppStatus = (patch = {}) => {
    const next = { ...current, ...patch, posts: { ...current.posts, ...(patch.posts || {}) } };
    if (!WHATSAPP_STATES.includes(next.state)) next.state = current.state;
    if (patch.state && patch.state !== "disabled") next.started = true;
    if (patch.state && !("reason" in patch)) next.reason = null;
    current = next;
    return getWhatsAppStatus();
};

/** Count one handled post ("saved" | "ignored" | "failed"). */
export const recordWhatsAppPost = (status, postedAt = new Date()) => {
    if (!["saved", "ignored", "failed"].includes(status)) return;
    current.posts[status] += 1;
    const time = postedAt instanceof Date ? postedAt : new Date(postedAt);
    if (!Number.isNaN(time.getTime()) && (!current.lastPostAt || time > current.lastPostAt)) current.lastPostAt = time;
};

/** Back to "disabled" (tests). */
export const resetWhatsAppStatus = () => {
    current = initialState();
};
