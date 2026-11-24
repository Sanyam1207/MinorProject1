// Runtime configuration (FRONTEND.md §17). Pure module: safe to import from
// `node --test`, where `import.meta.env` does not exist.
const env = import.meta.env ?? {};

/** Backend origin without `/api/v1`. Empty = same origin (Vite proxy or reverse proxy). */
export const API_ORIGIN = String(env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
export const API_BASE = `${API_ORIGIN}/api/v1`;

/** Product name shown in the header, sign-in screen, welcome message and document title. */
export const APP_NAME = String(env.VITE_APP_NAME || "Matchy Campus").trim() || "Matchy Campus";

/** Google Identity Services web client id. Empty → no Google button and no GoogleOAuthProvider. */
export const GOOGLE_CLIENT_ID = String(env.VITE_GOOGLE_CLIENT_ID || "").trim();

export const IS_DEV = Boolean(env.DEV);

/** Camera, geolocation, push and service workers need a secure context (https or localhost). */
export const IS_SECURE_CONTEXT = () => typeof window !== "undefined" && Boolean(window.isSecureContext);

/** Up to two initials for the brand box, e.g. "Matchy Campus" → "MC". */
export const APP_INITIALS =
  APP_NAME.split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("") || "MC";
