// Formatting helpers (FRONTEND.md §11.3): en-IN, browser time zone, "—" for missing values.
const LOCALE = "en-IN";
const DASH = "—";

const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatDate = (value, options = { day: "numeric", month: "short", year: "numeric" }) => {
  const date = toDate(value);
  return date ? date.toLocaleDateString(LOCALE, options) : DASH;
};

export const formatTime = (value) => {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" }) : DASH;
};

export const formatDateTime = (value) => {
  const date = toDate(value);
  return date
    ? date.toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
    : DASH;
};

/** "just now", "5 min ago", "in 2 h", "yesterday", "3 days ago", else the date. Pass `now` from useNow(). */
export const formatRelative = (value, now = Date.now()) => {
  const date = toDate(value);
  if (!date) return DASH;
  const diffSeconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(diffSeconds);
  const future = diffSeconds > 0;
  const phrase = (amount, unit) => (future ? `in ${amount} ${unit}` : `${amount} ${unit} ago`);
  if (abs < 45) return future ? "in a moment" : "just now";
  if (abs < 3600) return phrase(Math.max(1, Math.round(abs / 60)), "min");
  if (abs < 86400) return phrase(Math.round(abs / 3600), "h");
  const days = Math.round(abs / 86400);
  if (days === 1) return future ? "tomorrow" : "yesterday";
  if (days < 7) return phrase(days, "days");
  return formatDate(date);
};

export const formatPercent = (value, digits = 0) => {
  if (value === null || value === undefined || value === "") return DASH;
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : DASH;
};

/** 12 → "12 LPA", 12.5 → "12.5 LPA", "12 LPA" → "12 LPA", missing → "Not disclosed". */
export const formatLpa = (value) => {
  if (value === null || value === undefined || value === "") return "Not disclosed";
  const number = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return typeof value === "string" && value.trim() ? value.trim() : "Not disclosed";
  return `${Number.isInteger(number) ? number : number.toFixed(1).replace(/\.0$/, "")} LPA`;
};
