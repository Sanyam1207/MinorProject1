import { useSyncExternalStore } from "react";

// Shared ticking clocks. Components read "now" through this hook instead of
// calling Date.now() during render (react-hooks/purity); one interval per
// period serves every subscriber and stops when nobody listens.
const createClock = (intervalMs) => {
  const clock = { now: Date.now(), listeners: new Set(), timer: null };
  clock.getSnapshot = () => clock.now;
  clock.subscribe = (listener) => {
    clock.listeners.add(listener);
    if (!clock.timer) {
      clock.now = Date.now();
      clock.timer = setInterval(() => {
        clock.now = Date.now();
        clock.listeners.forEach((notify) => notify());
      }, intervalMs);
    }
    return () => {
      clock.listeners.delete(listener);
      if (clock.listeners.size === 0 && clock.timer) {
        clearInterval(clock.timer);
        clock.timer = null;
      }
    };
  };
  return clock;
};

const CLOCKS = new Map([1000, 5000, 15000, 30000, 60000].map((ms) => [ms, createClock(ms)]));

/** Current time in ms, refreshed every `intervalMs` (1 s, 5 s, 15 s, 30 s or 60 s). */
export function useNow(intervalMs = 30000) {
  const clock = CLOCKS.get(intervalMs) ?? CLOCKS.get(30000);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
