// CTC parsing and labels (docs/contracts/PLACEMENTS.md §2.4). Pure.
const round2 = (value) => Math.round(value * 100) / 100;
const NONE = Object.freeze({ min: null, max: null });
const UNDISCLOSED = /not\s*disclosed|n\/?a\b|\btbd\b|confidential/;
const MONTHLY = /per\s*month|\/\s*month|\/\s*mo\b|\bpm\b|p\.m\.|monthly/;

const inRange = (value) => Number.isFinite(value) && value > 0 && value <= 500;

const result = (min, max) => {
    const low = round2(min);
    const high = max === null || max === undefined ? low : round2(max);
    if (!inRange(low) || !inRange(high)) return { ...NONE };
    return low <= high ? { min: low, max: high } : { min: high, max: low };
};

const fromNumber = (value) => {
    if (!Number.isFinite(value)) return { ...NONE };
    if (value >= 10000) return result(value / 100000);
    if (value > 0 && value <= 500) return result(value);
    return { ...NONE };
};

/**
 * Parse a package (CTC) into LPA.
 * @returns {{min: number|null, max: number|null}}
 */
export const parsePackageLpa = (input) => {
    if (input === null || input === undefined || input === "") return { ...NONE };
    if (typeof input === "number") return fromNumber(input);
    if (typeof input !== "string") return { ...NONE };

    let text = input.toLowerCase().replace(/₹/g, " ").replace(/,/g, "");
    text = text.replace(/\brs\.?/g, " ").replace(/\binr\b/g, " ").replace(/\s+/g, " ").trim();
    if (!text || UNDISCLOSED.test(text) || !/\d/.test(text)) return { ...NONE };

    const match = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?/.exec(text);
    if (!match) return { ...NONE };
    let first = Number(match[1]);
    let second = match[2] !== undefined ? Number(match[2]) : null;
    const rest = text.slice(match.index + match[0].length);

    let convert;
    if (/^\s*(cr|crores?)\b/.test(rest) || /\b(cr|crores?)\b/.test(rest)) convert = (value) => value * 100;
    else if (/^\s*(lpa|lakhs?|lacs?|l)\b/.test(rest) || /\b(lpa|lakhs?|lacs?)\b/.test(rest)) convert = (value) => value;
    else if (/^\s*(k|thousand)\b/.test(rest) || /\b(thousand)\b/.test(rest)) convert = (value) => value / 100;
    else convert = (value) => (value >= 10000 ? value / 100000 : value);

    first = convert(first);
    if (second !== null) second = convert(second);
    if (MONTHLY.test(text)) {
        first *= 12;
        if (second !== null) second *= 12;
    }
    return result(first, second);
};

/** "18" / "12.5" (at most two decimals, no trailing zeros). */
export const formatLpa = (value) => (Number.isFinite(Number(value)) ? String(Number(Number(value).toFixed(2))) : "");

const isUndisclosedText = (text) => !text || /not\s*disclosed/i.test(text);

/** "12–15 LPA", "18 LPA", the original salary text, or "Not disclosed". */
export const packageLabel = (job = {}) => {
    const min = job.packageLpa;
    if (min === null || min === undefined || !Number.isFinite(Number(min))) {
        const salary = typeof job.salary === "string" ? job.salary.trim() : "";
        return isUndisclosedText(salary) ? "Not disclosed" : salary;
    }
    const max = job.packageMaxLpa;
    if (max !== null && max !== undefined && Number(max) > Number(min)) return `${formatLpa(min)}–${formatLpa(max)} LPA`;
    return `${formatLpa(min)} LPA`;
};

export { round2 };
