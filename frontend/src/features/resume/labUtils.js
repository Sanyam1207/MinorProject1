// Resume Lab helpers (pure; DOM is only touched inside functions, never at import).

export const LAB_TABS = Object.freeze([
  { id: "catalog", label: "Catalog" },
  { id: "editor", label: "Editor" },
  { id: "tailor", label: "AI Tailor" },
  { id: "ats", label: "ATS Score" },
  { id: "generator", label: "Generator" },
  { id: "skill-gap", label: "Skill Gap" },
]);

const TAB_IDS = new Set(LAB_TABS.map((tab) => tab.id));

/** Legacy tool ids from the pre-rewrite studio → lab tabs. */
const LEGACY_TOOLS = Object.freeze({ bank: "catalog", upload: "catalog", "ats-score": "ats", "resume.ats-score": "ats", "resume.skill-gap": "skill-gap" });

/** Normalise any tool id: lab tab id, "ai-keys", or null (home). */
export const normalizeTool = (tool) => {
  if (!tool) return null;
  if (tool === "ai-keys") return "ai-keys";
  if (TAB_IDS.has(tool)) return tool;
  return LEGACY_TOOLS[tool] ?? null;
};

export const isLabTab = (tool) => TAB_IDS.has(tool);

export const FULL_HEIGHT_TABS = new Set(["generator", "editor", "tailor"]);

export const KIND_LABELS = Object.freeze({ latex: "LaTeX", text: "Text", pdf: "PDF", docx: "DOCX" });
export const kindLabel = (kind) => KIND_LABELS[kind] || String(kind || "file").toUpperCase();

export const ORIGIN_LABELS = Object.freeze({
  uploaded: "Uploaded",
  created: "Created",
  generated: "AI generated",
  tailored: "Tailored",
  duplicated: "Copy",
  migrated: "Imported",
});
export const originLabel = (origin) => ORIGIN_LABELS[origin] || (origin ? String(origin) : "");

export const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

/** "campus:<id>" — the key every per-job value (JD drafts, picks) is stored under. */
export const jobKey = (jobSource, jobId) => (jobId ? `${jobSource || "campus"}:${jobId}` : "");

export const parseJobKey = (key) => {
  const [source, ...rest] = String(key || "").split(":");
  const jobIdValue = rest.join(":");
  return jobIdValue ? { jobSource: source === "market" ? "market" : "campus", jobId: jobIdValue } : { jobSource: null, jobId: null };
};

export const jobLabel = (job) => {
  if (!job) return "";
  const title = job.title || "Untitled role";
  return job.company ? `${title} · ${job.company}` : title;
};

/** LaTeX → "tex", text → "txt", otherwise null. */
export const sourceExtension = (kind) => (kind === "latex" ? "tex" : kind === "text" ? "txt" : null);

export const safeFileName = (value, fallback = "resume") =>
  String(value || "")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || fallback;

/** Save a Blob (or a text) as a download. Browser-only; call from event handlers. */
export const downloadBlob = (blobOrText, filename, type = "text/plain;charset=utf-8") => {
  if (typeof document === "undefined") return;
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([String(blobOrText ?? "")], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Open a URL in a new tab (signed links are root-relative when the API shares the origin). */
export const openInNewTab = (url) => {
  if (!url || typeof window === "undefined") return;
  window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Open a tab synchronously (inside the click handler, so pop-up blockers allow it)
 * and point it at a URL that is fetched afterwards. → { go(url), close() }
 */
export const openPendingTab = () => {
  const win = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
  return {
    go(url) {
      if (!url) return this.close();
      if (win && !win.closed) {
        try {
          win.opener = null;
        } catch {
          // ignore
        }
        win.location.href = url;
      } else {
        openInNewTab(url);
      }
      return undefined;
    },
    close() {
      if (win && !win.closed) win.close();
    },
  };
};

/** Status → colour class for ATS checks. */
export const CHECK_STATUS_COLORS = Object.freeze({ pass: "bg-green-200", warn: "bg-yellow-200", fail: "bg-red-200" });

export const scoreTone = (score) => (score >= 85 ? "bg-green-200" : score >= 70 ? "bg-green-100" : score >= 55 ? "bg-yellow-200" : "bg-red-200");

export const scoreVerdict = (score) =>
  score >= 85 ? "STRONG RESUME" : score >= 70 ? "GOOD FIT" : score >= 55 ? "AVERAGE FIT" : "NEEDS IMPROVEMENT";

/** Case/space-insensitive skill key. */
export const skillKey = (skill) => String(skill || "").toLowerCase().replace(/[^a-z0-9+#.]/g, "");

/** Compare profile skills with job skills → `{matched, missing}` (job's spelling kept). */
export const compareSkills = (have, need) => {
  const owned = new Set((Array.isArray(have) ? have : []).map((item) => skillKey(typeof item === "string" ? item : item?.name)).filter(Boolean));
  const matched = [];
  const missing = [];
  const seen = new Set();
  for (const skill of Array.isArray(need) ? need : []) {
    const key = skillKey(skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    (owned.has(key) ? matched : missing).push(skill);
  }
  return { matched, missing };
};

/** Profile skills as strings (user.skills may hold strings or {name}). */
export const profileSkills = (user) =>
  (Array.isArray(user?.skills) ? user.skills : [])
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter((item) => typeof item === "string" && item.trim());
