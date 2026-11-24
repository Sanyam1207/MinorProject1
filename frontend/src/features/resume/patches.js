// Tailoring patch helpers (FRONTEND.md §13.4). Pure: no DOM, no React.
//
// Patch = { id, section, targetContext, lineRange: {startLine, endLine},
//           charRange: {startChar, endChar}, originalSubstring, replacementSubstring,
//           keywordsAdded: string[], reasoning, autoEscaped? }
//
// The server (POST /resumes/:id/apply-patches) is the source of truth for
// applying; these helpers give the review list its STALE / OVERLAP flags and a
// local preview, using the same rules: exact match at charRange, else the
// nearest exact occurrence, overlaps skipped, applied in descending order.

const isPatch = (patch) =>
  Boolean(patch) && typeof patch === "object" && typeof patch.originalSubstring === "string" && typeof patch.replacementSubstring === "string";

/** Keep only well-formed patches and give each a stable string id. */
export const normalizePatches = (patches) =>
  (Array.isArray(patches) ? patches : []).filter(isPatch).map((patch, index) => ({
    ...patch,
    id: String(patch.id ?? `patch_${index + 1}`),
    section: patch.section || "General",
    targetContext: patch.targetContext || "",
    keywordsAdded: Array.isArray(patch.keywordsAdded) ? patch.keywordsAdded.filter((item) => typeof item === "string") : [],
    reasoning: patch.reasoning || "",
    charRange: patch.charRange && typeof patch.charRange === "object" ? patch.charRange : null,
    lineRange: patch.lineRange && typeof patch.lineRange === "object" ? patch.lineRange : null,
  }));

/** `content.slice(startChar, endChar) === originalSubstring`. */
export const validatePatch = (content, patch) => {
  if (!isPatch(patch) || typeof content !== "string") return false;
  const start = Number(patch.charRange?.startChar);
  const end = Number(patch.charRange?.endChar);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return false;
  return content.slice(start, end) === patch.originalSubstring;
};

/** Start index of the patch in `content`: exact charRange, else nearest exact occurrence, else -1. */
export const locatePatch = (content, patch) => {
  if (!isPatch(patch) || typeof content !== "string" || !patch.originalSubstring) return -1;
  if (validatePatch(content, patch)) return Number(patch.charRange.startChar);
  const hint = Number(patch.charRange?.startChar);
  const target = Number.isFinite(hint) ? hint : 0;
  let best = -1;
  for (let index = content.indexOf(patch.originalSubstring); index !== -1; index = content.indexOf(patch.originalSubstring, index + 1)) {
    if (best === -1 || Math.abs(index - target) < Math.abs(best - target)) best = index;
  }
  return best;
};

const rangeOf = (patch) => {
  const start = Number(patch.charRange?.startChar);
  const end = Number(patch.charRange?.endChar);
  return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
};

/** Ids of patches whose charRange overlaps an earlier (lower start) patch. */
export const findOverlaps = (patches) => {
  const ranged = (Array.isArray(patches) ? patches : [])
    .map((patch, order) => ({ patch, order, range: rangeOf(patch) }))
    .filter((item) => item.range)
    .sort((a, b) => a.range.start - b.range.start || a.order - b.order);
  const overlapping = new Set();
  let lastEnd = -1;
  for (const item of ranged) {
    if (item.range.start < lastEnd) {
      overlapping.add(String(item.patch.id));
      continue;
    }
    lastEnd = item.range.end;
  }
  return overlapping;
};

/**
 * Apply the accepted patches locally.
 * → `{ content, applied: id[], skipped: [{id, reason: "STALE"|"OVERLAP"}] }`
 */
export const applyPatches = (content, patches, acceptedIds) => {
  const accepted = acceptedIds instanceof Set ? acceptedIds : new Set((acceptedIds || []).map(String));
  const skipped = [];
  const located = [];
  (Array.isArray(patches) ? patches : []).forEach((patch, order) => {
    if (!isPatch(patch) || !accepted.has(String(patch.id))) return;
    const start = locatePatch(content, patch);
    if (start === -1) {
      skipped.push({ id: String(patch.id), reason: "STALE" });
      return;
    }
    located.push({ patch, order, start, end: start + patch.originalSubstring.length });
  });
  located.sort((a, b) => a.start - b.start || a.order - b.order);
  const kept = [];
  let lastEnd = -1;
  for (const item of located) {
    if (item.start < lastEnd) {
      skipped.push({ id: String(item.patch.id), reason: "OVERLAP" });
      continue;
    }
    kept.push(item);
    lastEnd = item.end;
  }
  let text = String(content ?? "");
  for (const item of [...kept].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, item.start) + item.patch.replacementSubstring + text.slice(item.end);
  }
  return { content: text, applied: kept.map((item) => String(item.patch.id)), skipped };
};

/** Per-patch review state against the current content: "ok" | "moved" | "stale" | "overlap". */
export const patchStates = (content, patches) => {
  const overlaps = findOverlaps(patches);
  const states = {};
  for (const patch of Array.isArray(patches) ? patches : []) {
    const key = String(patch.id);
    if (typeof content !== "string" || !content) states[key] = "ok";
    else if (validatePatch(content, patch)) states[key] = "ok";
    else states[key] = locatePatch(content, patch) === -1 ? "stale" : "moved";
    if (overlaps.has(key) && states[key] !== "stale") states[key] = "overlap";
  }
  return states;
};

/** Human text for server / client skip reasons. */
export const SKIP_REASON_LABELS = Object.freeze({
  stale: "the text changed since the suggestion was made",
  STALE: "the text changed since the suggestion was made",
  overlap: "it overlaps another accepted suggestion",
  OVERLAP: "it overlaps another accepted suggestion",
  unbalanced_braces: "it would break LaTeX braces",
  not_found: "the original text was not found",
  unchanged: "it did not change anything",
  invalid: "the suggestion was malformed",
  limit: "too many suggestions",
});

export const skipReasonLabel = (reason) => SKIP_REASON_LABELS[reason] || String(reason || "skipped");

// ── word diff for highlighting ─────────────────────────────────────────────

const MAX_DIFF_TOKENS = 600;
const tokenize = (text) => String(text ?? "").match(/\s+|[^\s]+/g) || [];

const merge = (parts) => {
  const out = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.changed === part.changed) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
};

/**
 * Word-level diff for highlighting.
 * → `{ before: [{text, changed}], after: [{text, changed}] }` (changed = removed in before, added in after).
 */
export const diffWords = (original, replacement) => {
  const a = tokenize(original);
  const b = tokenize(replacement);
  if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
    return { before: [{ text: String(original ?? ""), changed: true }], after: [{ text: String(replacement ?? ""), changed: true }] };
  }
  // LCS table (suffix form).
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Array(rows * cols).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const before = [];
  const after = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      before.push({ text: a[i], changed: false });
      after.push({ text: b[j], changed: false });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      before.push({ text: a[i], changed: true });
      i += 1;
    } else {
      after.push({ text: b[j], changed: true });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) before.push({ text: a[i], changed: true });
  for (; j < b.length; j += 1) after.push({ text: b[j], changed: true });
  // Whitespace-only "changes" are not worth highlighting.
  const tidy = (parts) => merge(parts.map((part) => (part.changed && !part.text.trim() ? { ...part, changed: false } : part)));
  return { before: tidy(before), after: tidy(after) };
};
