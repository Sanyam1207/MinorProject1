// Shared vocabulary of the open-market job feed (docs/contracts/JOB-FEED.md §2, §4, §6).

export const JOB_TYPES = Object.freeze(["full-time", "part-time", "internship", "contract"]);
export const WORK_TYPES = Object.freeze(["onsite", "remote", "hybrid"]);
export const SAVED_JOB_STATUSES = Object.freeze(["saved", "applied", "interviewing", "offer", "rejected"]);
/** Statuses that mean the student has applied (appliedAt is set the first time one of them is reached). */
export const APPLIED_STATUSES = Object.freeze(["applied", "interviewing", "offer", "rejected"]);

export const SOURCE_LABELS = Object.freeze({
    debugwithshubham: "DebugWithShubham",
    artha: "artha.link",
    whatsapp: "WhatsApp",
    sample: "Sample",
});
/** Every source the feed knows, in the order GET /sources lists them. */
export const ALL_SOURCES = Object.freeze(["debugwithshubham", "artha", "whatsapp", "sample"]);
/** Sources the sync service polls (WhatsApp pushes, the sample seed is demo-only). */
export const POLLED_SOURCES = Object.freeze(["debugwithshubham", "artha"]);
export const SAMPLE_SOURCE = "sample";
export const WHATSAPP_SOURCE = "whatsapp";

export const SYNC_TRIGGERS = Object.freeze(["boot", "schedule", "manual", "cron", "agent"]);
export const SYNC_STATUSES = Object.freeze(["running", "ok", "partial", "failed"]);

/** How many of the newest matching jobs `sort=match` scores (and the resolver scans). */
export const MATCH_CANDIDATE_WINDOW = 500;

/** City spellings that mean the same place; the first entry is the canonical form. */
export const LOCATION_ALIASES = Object.freeze([
    ["bengaluru", "bangalore"],
    ["gurugram", "gurgaon"],
    ["mumbai", "bombay"],
    ["chennai", "madras"],
    ["kolkata", "calcutta"],
    ["kochi", "cochin"],
    ["thiruvananthapuram", "trivandrum"],
    ["visakhapatnam", "vizag"],
    ["mysuru", "mysore"],
    ["delhi", "new delhi", "ncr"],
].map((group) => Object.freeze(group)));

export const sourceLabel = (name) => SOURCE_LABELS[name] || String(name ?? "");

/** The alias group that contains `place` (lowercase, trimmed), or null. */
export const locationAliasGroup = (place) => {
    const value = String(place ?? "").trim().toLowerCase();
    if (!value) return null;
    return LOCATION_ALIASES.find((group) => group.includes(value)) || null;
};

/** Every spelling of `place`: its alias group, or just the place itself. */
export const locationVariants = (place) => {
    const value = String(place ?? "").trim().toLowerCase();
    if (!value) return [];
    return [...(locationAliasGroup(value) || [value])];
};
