// Authentication API (FRONTEND.md §14.2, AUTH-FACULTY.md §5).
// Every function lets ApiClientError propagate; components branch on `error.code`.
import { http } from "../http.js";
import { setItem } from "../storage.js";

const withCookies = { withCredentials: true };
const tokenPath = (token) => encodeURIComponent(String(token ?? ""));

const ROLE_ALIASES = { faculty: "teacher", recruiter: "company" };
const normalizeRole = (role) => (role ? ROLE_ALIASES[role] || role : undefined);

const toSession = (data) => ({
  user: data?.user ?? null,
  accessToken: data?.accessToken ?? null,
  isNewUser: Boolean(data?.isNewUser),
  roleAdjusted: Boolean(data?.roleAdjusted),
});

export const DEFAULT_AUTH_OPTIONS = Object.freeze({
  appName: null,
  collegeDomains: [],
  google: { enabled: null },
  passwordReset: { emailEnabled: null },
  passwordMinLength: 8,
});

/** Public sign-in options. `null` flags mean "unknown" (endpoint missing or unreachable). */
export async function getAuthOptions() {
  const data = await http.get("/auth/options");
  return {
    appName: typeof data?.appName === "string" ? data.appName : null,
    collegeDomains: Array.isArray(data?.collegeDomains)
      ? data.collegeDomains.filter((item) => item && typeof item.domain === "string")
      : [],
    google: { enabled: typeof data?.google?.enabled === "boolean" ? data.google.enabled : null },
    passwordReset: {
      emailEnabled: typeof data?.passwordReset?.emailEnabled === "boolean" ? data.passwordReset.emailEnabled : null,
    },
    passwordMinLength: Number(data?.passwordMinLength) || 8,
  };
}

/** Existing users sign in with their stored role; new emails register with `role`. */
export async function loginOrRegister({ email, password, role, name } = {}) {
  const body = { email: String(email ?? "").trim().toLowerCase(), password };
  const normalizedRole = normalizeRole(role);
  if (normalizedRole) body.role = normalizedRole;
  if (name) body.name = name;
  return toSession(await http.post("/auth/login-or-register", body, withCookies));
}

/** Google Identity Services credential (ID token) → session. */
export async function googleLogin({ credential, role } = {}) {
  return toSession(await http.post("/auth/google", { credential, role: normalizeRole(role) }, withCookies));
}

export async function getMe() {
  return http.get("/auth/me");
}

export async function updateMe(patch) {
  return http.patch("/auth/me", patch);
}

/** Revokes the refresh session (cookie) and clears auth cookies. */
export async function logoutRequest() {
  await http.post("/auth/logout", {}, withCookies);
}

export async function logoutAllRequest() {
  return http.post("/auth/logout-all", {}, withCookies);
}

export async function forgotPassword(email) {
  await http.post("/auth/forgot-password", { email: String(email ?? "").trim().toLowerCase() });
}

/** → `{ valid, email, expiresAt }`; 400 RESET_TOKEN_INVALID when the link is dead. */
export async function checkResetToken(token) {
  const data = await http.get(`/auth/reset-password/${tokenPath(token)}`);
  return { valid: data?.valid !== false, email: data?.email ?? null, expiresAt: data?.expiresAt ?? null };
}

export async function resetPassword(token, password) {
  await http.post(`/auth/reset-password/${tokenPath(token)}`, { password });
}

/** → `{ accessToken, user }` (the server rotates the token version). */
export async function changePassword({ currentPassword, newPassword } = {}) {
  const body = { newPassword };
  if (currentPassword) body.currentPassword = currentPassword;
  const data = await http.post("/auth/change-password", body, withCookies);
  return { accessToken: data?.accessToken ?? null, user: data?.user ?? null };
}

/** Store a fresh access token and let the socket re-authenticate (realtime.js listens). */
export function storeAccessToken(token) {
  if (!token) return;
  setItem("token", token);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("auth:token-refreshed", { detail: { token } }));
  }
}

/** AUTH-FACULTY.md §14.1 object form, for code written against that contract. */
export const authApi = Object.freeze({
  options: getAuthOptions,
  loginOrRegister,
  google: googleLogin,
  logout: logoutRequest,
  logoutAll: logoutAllRequest,
  me: getMe,
  updateMe,
  forgotPassword,
  checkResetToken,
  resetPassword,
  changePassword,
});
