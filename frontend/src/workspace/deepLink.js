// Panel deep links (UI-ACTIONS.md §9):
//   ${origin}/?panel=<panelId>&params=<encodeURIComponent(JSON.stringify(params))>&nid=<notificationId>
// Pure module (node-tested).

const DEEP_LINK_KEYS = ["panel", "params", "nid"];

const fallbackOrigin = () => (typeof window !== "undefined" && window.location?.origin) || "http://localhost";

export function buildPanelUrl({ panel, params } = {}, { origin, notificationId } = {}) {
  const base = String(origin ?? fallbackOrigin()).replace(/\/+$/, "");
  const parts = [`panel=${encodeURIComponent(panel ?? "")}`];
  if (params && typeof params === "object" && Object.keys(params).length > 0) {
    parts.push(`params=${encodeURIComponent(JSON.stringify(params))}`);
  }
  if (notificationId) parts.push(`nid=${encodeURIComponent(notificationId)}`);
  return `${base}/?${parts.join("&")}`;
}

const toSearch = (input) => {
  if (typeof input !== "string") return "";
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("/")) {
    try {
      return new URL(value, "http://localhost").search;
    } catch {
      return "";
    }
  }
  return value;
};

/** `?panel=…` (or a full URL) → `{ panel, params, nid } | null`. Malformed params → `{}`. */
export function parsePanelUrl(input) {
  const search = new URLSearchParams(toSearch(input));
  const panel = search.get("panel");
  if (!panel) return null;
  let params = {};
  const rawParams = search.get("params");
  if (rawParams) {
    try {
      const parsed = JSON.parse(rawParams);
      params = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      params = {};
    }
  }
  return { panel, params, nid: search.get("nid") || null };
}

/** Same search string without `panel`, `params`, `nid` (other keys such as gmail_connected stay). */
export function stripPanelParams(search) {
  const parsed = new URLSearchParams(typeof search === "string" ? search : "");
  for (const key of DEEP_LINK_KEYS) parsed.delete(key);
  const rest = parsed.toString();
  return rest ? `?${rest}` : "";
}

/** Same-origin check used before following a link from a push payload. */
export function isSameOriginUrl(url, origin = fallbackOrigin()) {
  try {
    return new URL(url, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
