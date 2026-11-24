// Pure scanning helpers for the student attendance flow (FRONTEND.md §13.2).
// No JSX, no top-level window/document/localStorage access.
import { submitScan } from "../../../lib/api/attendance.js";
import { getItem, setItem } from "../../../lib/storage.js";

export const DEVICE_ID_KEY = "attendance-device-id";

/**
 * Decoded QR text / pasted link → `{ sessionId, token, version } | null`.
 * Accepts an absolute URL or a path whose pathname ends with `/attend` and has
 * non-empty `s` and `t`. Any origin is accepted: only `s`/`t` are used and the
 * app never navigates to a scanned URL.
 */
export function parseAttendUrl(text) {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value, "http://scan.local");
  } catch {
    return null;
  }
  if (!/\/attend\/?$/i.test(url.pathname)) return null;
  const sessionId = (url.searchParams.get("s") || "").trim();
  const token = (url.searchParams.get("t") || "").trim();
  if (!sessionId || !token) return null;
  const rawVersion = Number.parseInt(url.searchParams.get("v") || "", 10);
  return { sessionId, token, version: Number.isFinite(rawVersion) ? rawVersion : null };
}

const randomId = () => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // insecure context without the polyfill — fall through
    }
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

let memoryDeviceId = null;

/** Persistent random id of this phone (localStorage "attendance-device-id"), created once. */
export function getDeviceId() {
  const stored = getItem(DEVICE_ID_KEY);
  if (stored && stored.trim()) return stored.trim();
  if (memoryDeviceId) return memoryDeviceId;
  const id = randomId();
  memoryDeviceId = id;
  setItem(DEVICE_ID_KEY, id);
  return id;
}

/** Client-side failure shaped like ApiClientError so the UI branches on `code` only. */
export class ScanClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScanClientError";
    this.code = code;
    this.status = 0;
    this.details = null;
  }
}

/** High-accuracy position → `{ lat, lng, accuracy }`; rejects with ScanClientError("LOCATION_UNAVAILABLE"). */
export function getHighAccuracyPosition({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    const secure = typeof window !== "undefined" ? Boolean(window.isSecureContext) : false;
    if (!nav?.geolocation || !secure) {
      reject(
        new ScanClientError(
          "LOCATION_UNAVAILABLE",
          "This class needs your location, and location needs a secure (https) connection. Open the app over https, or ask your teacher to mark you.",
        ),
      );
      return;
    }
    nav.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (error) => {
        const message =
          error?.code === 1
            ? "Location permission is blocked. Allow location for this site in your browser settings, then scan again."
            : error?.code === 3
              ? "Couldn't get your location in time. Step near a window or turn on GPS, then scan again."
              : "Couldn't read your location. Turn on location services, then scan again.";
        reject(new ScanClientError("LOCATION_UNAVAILABLE", message));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

/**
 * POST /attendance/scan for one decoded token. Sends geo ONLY when the server
 * answers LOCATION_REQUIRED (then asks for a high-accuracy position and
 * retries once — that rejection does not consume the token).
 */
export async function submitAttendance({ sessionId, token }, { onLocating } = {}) {
  const deviceId = getDeviceId();
  try {
    return await submitScan({ sessionId, token, deviceId });
  } catch (error) {
    if (error?.code !== "LOCATION_REQUIRED") throw error;
    onLocating?.();
    const geo = await getHighAccuracyPosition();
    return submitScan({ sessionId, token, deviceId, geo });
  }
}

export const isCameraSupported = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";

export const isSecureOrigin = () => typeof window !== "undefined" && Boolean(window.isSecureContext);

export const vibrate = (pattern = 80) => {
  try {
    if (typeof navigator !== "undefined") navigator.vibrate?.(pattern);
  } catch {
    // unsupported
  }
};
