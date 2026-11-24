// Web-push helpers (FRONTEND.md §9.4). Browser-only APIs are always guarded.

export const SERVICE_WORKER_URL = "/sw.js";

export const isPushSupported = () =>
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window &&
  Boolean(window.isSecureContext);

export const notificationPermission = () =>
  typeof window !== "undefined" && "Notification" in window ? window.Notification.permission : "default";

/** iOS Safari only exposes Web Push to Home-Screen apps (standalone display mode). */
export const needsHomeScreenInstall = () => {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const isIos = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;
  return isIos && !standalone;
};

/** VAPID public key (base64url) → Uint8Array for pushManager.subscribe. */
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = globalThis.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

export async function registerServiceWorker() {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration;
}

export async function getExistingRegistration() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? null;
  } catch {
    return null;
  }
}

export async function getCurrentSubscription() {
  const registration = await getExistingRegistration();
  if (!registration?.pushManager) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Subscribe (or re-subscribe when the server key changed). */
export async function subscribeWithKey(registration, publicKey) {
  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    try {
      return await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    } catch {
      await existing.unsubscribe().catch(() => {});
    }
  }
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}
