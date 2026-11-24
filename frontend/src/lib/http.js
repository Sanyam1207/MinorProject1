// Shared HTTP client for every feature module (src/lib/api/*.js).
//
// - Sends the access token from localStorage as a Bearer header.
// - Unwraps the backend envelope: resolves with `body.data` (use `raw: true`
//   in the axios config to get the whole envelope).
// - On a 401 it performs ONE shared refresh (POST /auth/refresh-token with the
//   httpOnly refresh cookie), stores the new token, re-authenticates the
//   socket and retries the request once. If refreshing fails it emits the
//   window event "auth:expired" so the app shell can sign the user out.
// - Errors are normalised to ApiClientError { status, code, message, details }.
//
// Normal requests are sent WITHOUT cookies on purpose: the backend prefers a
// cookie token over the Authorization header, so a stale cookie would
// otherwise shadow a fresh header token.
import axios from "axios";
import { API_BASE } from "./config.js";

export class ApiClientError extends Error {
  constructor({ status = 0, code = "NETWORK", message = "Request failed", details = null } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const getAccessToken = () => localStorage.getItem("token") || null;

export const http = axios.create({ baseURL: API_BASE, timeout: 30000 });

http.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token && !config.headers?.Authorization) {
    config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };
  }
  return config;
});

let refreshPromise = null;

const refreshAccessToken = async () => {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE}/auth/refresh-token`, {}, { withCredentials: true, timeout: 15000 })
      .then((response) => {
        const token = response.data?.data?.accessToken;
        if (!token) throw new Error("No access token in refresh response");
        localStorage.setItem("token", token);
        window.dispatchEvent(new CustomEvent("auth:token-refreshed", { detail: { token } }));
        return token;
      })
      .finally(() => {
        setTimeout(() => { refreshPromise = null; }, 0);
      });
  }
  return refreshPromise;
};

const toClientError = (error) => {
  if (error instanceof ApiClientError) return error;
  const status = error?.response?.status || 0;
  const body = error?.response?.data;
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  return new ApiClientError({
    status,
    code: (first && typeof first === "object" && first.code) || (status === 0 ? "NETWORK" : "ERROR"),
    message: body?.message || (status === 0 ? "Cannot reach the server. Check your connection." : error?.message || "Request failed"),
    details: first && typeof first === "object" ? first : body?.errors || null,
  });
};

const isEnvelope = (body) =>
  Boolean(body) && typeof body === "object" && !Array.isArray(body) && "success" in body && "data" in body;

http.interceptors.response.use(
  (response) => {
    if (response.config?.raw || response.config?.responseType === "blob") return response.data;
    return isEnvelope(response.data) ? response.data.data : response.data;
  },
  async (error) => {
    const original = error?.config;
    const status = error?.response?.status;
    const isAuthCall = /\/auth\/(login|register|login-or-register|refresh-token|google)/.test(original?.url || "");
    if (status === 401 && original && !original._retried && !isAuthCall && getAccessToken()) {
      original._retried = true;
      try {
        const token = await refreshAccessToken();
        original.headers = { ...(original.headers || {}), Authorization: `Bearer ${token}` };
        return http(original);
      } catch {
        window.dispatchEvent(new CustomEvent("auth:expired"));
      }
    }
    return Promise.reject(toClientError(error));
  },
);

/** Human-friendly message for any thrown value. */
export const errorMessage = (error, fallback = "Something went wrong") =>
  error?.message && error.message !== "Request failed" ? error.message : fallback;
