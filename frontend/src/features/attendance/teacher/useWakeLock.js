// Keep the screen on while presenting (Screen Wake Lock API, when available).
// The lock is released by the browser when the tab is hidden, so it is
// re-acquired on visibilitychange.
import { useEffect, useState } from "react";

export const wakeLockSupported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

/** → `{ supported, active }` */
export function useWakeLock(enabled = true) {
  const [active, setActive] = useState(false);
  const supported = wakeLockSupported();

  useEffect(() => {
    if (!enabled || !supported) return undefined;
    let sentinel = null;
    let disposed = false;

    const acquire = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        setActive(true);
        lock.addEventListener("release", () => {
          if (sentinel === lock) {
            sentinel = null;
            if (!disposed) setActive(false);
          }
        });
      } catch {
        if (!disposed) setActive(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !sentinel) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinel) sentinel.release().catch(() => {});
      sentinel = null;
    };
  }, [enabled, supported]);

  return { supported, active: supported && enabled && active };
}
