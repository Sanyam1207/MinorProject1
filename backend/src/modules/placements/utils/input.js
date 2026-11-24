// Request input helpers (docs/contracts/PLACEMENTS.md §2.7). Unknown body keys are ignored everywhere.
import { assertObjectId, fail } from "../../../core/http.js";

const invalid = (field, message) => fail(400, message, "VALIDATION", { field });
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** Trimmed string; `undefined` when blank (400 when required). */
export const str = (value, { max = 1000, min = 0, required = false, field = "value" } = {}) => {
    if (isBlank(value)) {
        if (required) throw invalid(field, `${field} is required`);
        return undefined;
    }
    if (typeof value !== "string" && typeof value !== "number") throw invalid(field, `${field} must be text`);
    const text = String(value).trim();
    if (text.length < min) throw invalid(field, `${field} must be at least ${min} characters`);
    if (text.length > max) throw invalid(field, `${field} must be at most ${max} characters`);
    return text;
};

/** Number (numeric strings accepted); "" and NaN → undefined. */
export const num = (value, { min = -Infinity, max = Infinity, int = false, required = false, field = "value" } = {}) => {
    if (isBlank(value)) {
        if (required) throw invalid(field, `${field} is required`);
        return undefined;
    }
    const parsed = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed)) {
        if (required) throw invalid(field, `${field} must be a number`);
        return undefined;
    }
    if (int && !Number.isInteger(parsed)) throw invalid(field, `${field} must be a whole number`);
    if (parsed < min || parsed > max) throw invalid(field, `${field} must be between ${min} and ${max}`);
    return parsed;
};

/** Array or comma-separated string → trimmed, non-empty, case-insensitively deduped strings. */
export const list = (value, { maxItems = 50, maxLen = 100, field = "value" } = {}) => {
    if (isBlank(value)) return [];
    let items;
    if (Array.isArray(value)) items = value;
    else if (typeof value === "string") items = value.split(",");
    else throw invalid(field, `${field} must be a list`);
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (item === null || item === undefined) continue;
        if (typeof item !== "string" && typeof item !== "number") throw invalid(field, `${field} must contain text values`);
        const text = String(item).trim();
        if (!text) continue;
        if (text.length > maxLen) throw invalid(field, `Each ${field} entry must be at most ${maxLen} characters`);
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    if (out.length > maxItems) throw invalid(field, `${field} accepts at most ${maxItems} entries`);
    return out;
};

export const bool = (value) => value === true || value === "true" || value === 1 || value === "1";

export const objectId = (value, field = "id") => assertObjectId(value, field);

/** An https URL (≤ max chars) or undefined. */
export const httpsUrl = (value, { field = "url", max = 500 } = {}) => {
    const text = str(value, { field, max });
    if (text === undefined) return undefined;
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw invalid(field, `${field} must be a valid https URL`);
    }
    if (parsed.protocol !== "https:") throw invalid(field, `${field} must be an https URL`);
    return parsed.toString();
};

/** One value of an enum (case-insensitive) or undefined. */
export const oneOf = (value, allowed, { field = "value", required = false } = {}) => {
    const text = str(value, { field, max: 60, required });
    if (text === undefined) return undefined;
    const match = allowed.find((option) => option.toLowerCase() === text.toLowerCase());
    if (!match) throw invalid(field, `${field} must be one of: ${allowed.join(", ")}`);
    return match;
};

/** A comma list / array of enum values; "all" (or empty) → null. */
export const enumList = (value, allowed, { field = "status" } = {}) => {
    const items = list(value, { maxItems: allowed.length + 1, maxLen: 40, field });
    if (items.length === 0 || items.some((item) => item.toLowerCase() === "all")) return null;
    return items.map((item) => oneOf(item, allowed, { field }));
};
