// Job-feed settings (docs/contracts/JOB-FEED.md §15). Read from process.env on
// every call, so tests and long-running processes always see the current value.

const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
const MAX_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_RETENTION_DAYS = 45;
const MAX_RETENTION_DAYS = 3650;

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Integer in [min, max]; anything else (blank, "abc", 1.5, out of range) → fallback. */
export const parseBoundedInt = (value, { min, max, fallback }) => {
    const raw = text(value);
    if (!/^[+-]?\d+$/.test(raw)) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return parsed >= min && parsed <= max ? parsed : fallback;
};

/** "true/1/yes/on" → true, "false/0/no/off" → false, anything else → fallback. */
export const parseBoolean = (value, fallback) => {
    const raw = text(value).toLowerCase();
    if (TRUE_WORDS.has(raw)) return true;
    if (FALSE_WORDS.has(raw)) return false;
    return fallback;
};

/** Comma list → unique, trimmed, lowercase entries. */
export const parseList = (value) =>
    [...new Set(String(value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];

export const getJobFeedConfig = (env = process.env) => ({
    syncIntervalMinutes: parseBoundedInt(env.JOB_SYNC_INTERVAL_MINUTES, {
        min: 0,
        max: MAX_SYNC_INTERVAL_MINUTES,
        fallback: DEFAULT_SYNC_INTERVAL_MINUTES,
    }),
    syncOnBoot: parseBoolean(env.JOB_SYNC_ON_BOOT, true),
    adminSyncSecret: typeof env.ADMIN_SYNC_SECRET === "string" ? env.ADMIN_SYNC_SECRET : "",
    fromArtha: parseBoolean(env.FROM_ARTHA, false),
    arthaKeywords: parseList(env.ARTHA_KEYWORDS),
    arthaLocation: text(env.ARTHA_LOCATION).toUpperCase() || "IN",
    arthaCountries: parseList(env.ARTHA_COUNTRIES).map((code) => code.toUpperCase()),
    retentionDays: parseBoundedInt(env.JOB_FEED_RETENTION_DAYS, {
        min: 0,
        max: MAX_RETENTION_DAYS,
        fallback: DEFAULT_RETENTION_DAYS,
    }),
    matchDigest: parseBoolean(env.JOB_FEED_MATCH_DIGEST, true),
    whatsappEnabled: parseBoolean(env.WHATSAPP_ENABLED, false),
    whatsappChannels: text(env.WHATSAPP_CHANNELS),
    whatsappLlmEmail: text(env.WHATSAPP_LLM_EMAIL).toLowerCase(),
    whatsappLlmProvider: text(env.WHATSAPP_LLM_PROVIDER).toLowerCase(),
    whatsappLlmModel: text(env.WHATSAPP_LLM_MODEL),
    whatsappPairingNumber: text(env.WHATSAPP_PAIRING_NUMBER).replace(/\D/g, ""),
});

export const JOB_FEED_DEFAULTS = Object.freeze({
    syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
    retentionDays: DEFAULT_RETENTION_DAYS,
});
