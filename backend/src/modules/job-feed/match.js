// Deterministic, explainable fit score between a user profile and an external
// job (docs/contracts/JOB-FEED.md §6).
import { escapeRegex } from "../../core/http.js";
import { LOCATION_ALIASES, locationAliasGroup } from "./constants.js";

const MAX_SKILLS = 40;
const SKILL_MIN_LENGTH = 2;
const SKILL_MAX_LENGTH = 40;
const SKILL_DIVISOR_CAP = 6;
const MAX_MATCHED_SKILLS = 5;
const ROLE_STOPWORDS = new Set(["and", "the", "for", "with", "of", "in", "at"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const asStrings = (value) => (Array.isArray(value) ? value : []).filter((item) => typeof item === "string");

/** Canonical spelling of a place: the first entry of its alias group, or the lowercase place itself. */
export const canonicalLocation = (place) => {
    const value = String(place ?? "").trim().toLowerCase();
    if (!value) return "";
    return locationAliasGroup(value)?.[0] || value;
};

const skillPattern = (skill) => new RegExp(`(^|[^a-z0-9+#.])${escapeRegex(skill)}($|[^a-z0-9+#])`);

const roleWords = (role) => role.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !ROLE_STOPWORDS.has(word));

/**
 * Profile signals used to score jobs, or null when the user has no skills, no
 * preferred roles and no preferred locations.
 * @returns {null | {skills: string[], roles: string[], locations: string[], prefersRemote: boolean, skillLabels: string[]}}
 */
export const buildProfileSignals = (user) => {
    if (!user || typeof user !== "object") return null;
    const labels = new Map();
    const projectSkills = (Array.isArray(user.projects) ? user.projects : []).flatMap((project) => asStrings(project?.skills));
    for (const raw of [...asStrings(user.skills), ...projectSkills]) {
        const label = raw.trim();
        const key = label.toLowerCase();
        if (key.length < SKILL_MIN_LENGTH || key.length > SKILL_MAX_LENGTH || labels.has(key)) continue;
        labels.set(key, label);
        if (labels.size >= MAX_SKILLS) break;
    }
    const preferences = user.careerPreferences && typeof user.careerPreferences === "object" ? user.careerPreferences : {};
    const roles = [...new Set(asStrings(preferences.preferredRoles).map((role) => role.trim().toLowerCase()).filter(Boolean))];
    const locations = [...new Set(asStrings(preferences.preferredLocations).map(canonicalLocation).filter(Boolean))];
    if (labels.size === 0 && roles.length === 0 && locations.length === 0) return null;
    return {
        skills: [...labels.keys()],
        skillLabels: [...labels.values()],
        roles,
        locations,
        prefersRemote: locations.includes("remote"),
    };
};

// Regexes are compiled once per signals object (a ranking request scores up to 500 jobs).
const compiled = new WeakMap();
const compile = (signals) => {
    let entry = compiled.get(signals);
    if (!entry) {
        entry = {
            skills: signals.skills.map((skill, index) => ({
                label: signals.skillLabels?.[index] ?? skill,
                pattern: skillPattern(skill),
            })),
            roles: signals.roles
                .map(roleWords)
                .filter((words) => words.length > 0)
                .map((words) => words.map((word) => new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}`))),
            locations: signals.locations
                .filter((place) => place !== "remote")
                .map((place) => (LOCATION_ALIASES.find((group) => group[0] === place) || [place])),
        };
        compiled.set(signals, entry);
    }
    return entry;
};

/**
 * Score one job for a profile.
 * @returns {{score: number|null, matchedSkills: string[]}} score 0..100, null without signals
 */
export const scoreExternalJob = (job, signals, now = new Date()) => {
    if (!signals) return { score: null, matchedSkills: [] };
    const { skills, roles, locations } = compile(signals);
    const title = String(job?.title ?? "").toLowerCase();
    const categories = Array.isArray(job?.categories) ? job.categories.join(" ") : "";
    const haystack = `${title} ${categories} ${job?.description || ""}`.toLowerCase();

    const matched = skills.filter(({ pattern }) => pattern.test(haystack)).map(({ label }) => label);
    const divisor = Math.min(skills.length, SKILL_DIVISOR_CAP);
    const skillPoints = divisor > 0 ? (50 * Math.min(matched.length, divisor)) / divisor : 0;

    let rolePoints = 0;
    for (const patterns of roles) {
        const hits = patterns.filter((pattern) => pattern.test(title)).length;
        if (hits === patterns.length) {
            rolePoints = 30;
            break;
        }
        if (hits > 0) rolePoints = 15;
    }

    const jobLocation = String(job?.location ?? "").toLowerCase();
    const locationMatches = locations.some((variants) => variants.some((variant) => jobLocation.includes(variant)))
        || (signals.prefersRemote && job?.workType === "remote");
    const locationPoints = locationMatches ? 10 : 0;

    const postedAt = job?.postedAt ? new Date(job.postedAt).getTime() : Number.NaN;
    const ageMs = now.getTime() - postedAt;
    let freshnessPoints = 0;
    if (Number.isFinite(ageMs)) {
        if (ageMs <= 3 * DAY_MS) freshnessPoints = 10;
        else if (ageMs <= 14 * DAY_MS) freshnessPoints = 5;
    }

    return {
        score: Math.round(Math.min(100, skillPoints + rolePoints + locationPoints + freshnessPoints)),
        matchedSkills: matched.slice(0, MAX_MATCHED_SKILLS),
    };
};
