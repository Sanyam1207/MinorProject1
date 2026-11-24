// Loaded first by main.jsx (before the Redux store is created).
//
// crypto.randomUUID only exists in secure contexts (HTTPS or localhost). On a
// phone opening the dev server over plain http://<LAN-IP> the app would crash
// at boot without this fallback. getRandomValues is available everywhere.
if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = function randomUUID() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
