/* Matchy Campus service worker — web push only (FRONTEND.md §9.4).
 * Plain script, no imports, no fetch handler (the app is never served from cache).
 * Payload: JSON { title, body, url, tag, notificationId, priority } (plain text accepted).
 * Clicks only ever open/focus URLs on THIS origin.
 */
const DEFAULT_TITLE = "Matchy Campus";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const parsePayload = (event) => {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === "object" ? parsed : { body: String(parsed) };
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
};

self.addEventListener("push", (event) => {
  const payload = parsePayload(event);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : DEFAULT_TITLE;
  const tag = payload.tag || payload.notificationId || undefined;
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    tag,
    renotify: Boolean(tag),
    requireInteraction: payload.priority === "high",
    data: { url: typeof payload.url === "string" ? payload.url : "/", notificationId: payload.notificationId || null },
    icon: "/favicon.svg",
    badge: "/favicon.svg",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Resolve against our origin; anything pointing elsewhere falls back to "/". */
const safeUrl = (raw) => {
  const origin = self.location.origin;
  try {
    const url = new URL(raw || "/", origin);
    return url.origin === origin ? url : new URL("/", origin);
  } catch {
    return new URL("/", origin);
  }
};

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = windows.filter((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });

      // The app shell at "/" applies the link itself (no reload, chat state kept).
      const appWindow = sameOrigin.find((client) => new URL(client.url).pathname === "/");
      if (appWindow) {
        await appWindow.focus();
        appWindow.postMessage({ type: "open-url", url: target.href });
        return;
      }

      // Another page of the app (e.g. /attend): navigate it to the deep link.
      for (const client of sameOrigin) {
        try {
          const navigated = await client.navigate(target.href);
          if (navigated) {
            await navigated.focus();
            return;
          }
        } catch {
          // Uncontrolled clients cannot be navigated; try the next one.
        }
      }

      await self.clients.openWindow(target.href);
    })(),
  );
});
