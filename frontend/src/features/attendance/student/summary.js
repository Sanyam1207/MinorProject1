// useAttendanceSummary() for the StudentMode tiles (FRONTEND.md §11.1):
//   → { overallPercent: number|null, status: "safe"|"warning"|"critical"|"no-data", nextClass: Session|null, loading, error }
// One getMySummary() + getMySchedule({days: 2}), cached in module memory for
// 60 s and shared by every caller. Never throws.
import { useSyncExternalStore } from "react";
import { getMySchedule, getMySummary } from "../../../lib/api/attendance.js";
import { useAsync } from "../../../ui/useAsync.js";
import { normalizeSessions, normalizeSummary, pickNextClass } from "./view.js";

const TTL_MS = 60_000;

let cache = { value: null, at: 0, promise: null };
let generation = 0;
const listeners = new Set();

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getGeneration = () => generation;

/** Drop the cached summary (after a scan or joining a course) and refresh every tile. */
export function invalidateAttendanceSummary() {
  cache = { value: null, at: 0, promise: null };
  generation += 1;
  listeners.forEach((notify) => notify());
}

async function fetchSummary() {
  const [summaryResult, scheduleResult] = await Promise.allSettled([getMySummary(), getMySchedule({ days: 2 })]);
  if (summaryResult.status === "rejected" && scheduleResult.status === "rejected") throw summaryResult.reason;
  const summary = summaryResult.status === "fulfilled" ? normalizeSummary(summaryResult.value) : null;
  const sessions = scheduleResult.status === "fulfilled" ? normalizeSessions(scheduleResult.value) : [];
  return {
    overallPercent: summary?.overall.percent ?? null,
    status: summary?.overall.status ?? "no-data",
    nextClass: pickNextClass(sessions, Date.now()),
  };
}

/** Cached loader (60 s); concurrent callers share one request. */
export function loadAttendanceSummary({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL_MS) return Promise.resolve(cache.value);
  if (cache.promise) return cache.promise;
  const promise = fetchSummary()
    .then((value) => {
      if (cache.promise === promise) cache = { value, at: Date.now(), promise: null };
      return value;
    })
    .catch((error) => {
      if (cache.promise === promise) cache = { ...cache, promise: null };
      throw error;
    });
  cache = { ...cache, promise };
  return promise;
}

export function useAttendanceSummary() {
  const version = useSyncExternalStore(subscribe, getGeneration, getGeneration);
  const { data, error, loading } = useAsync(() => loadAttendanceSummary(), [version]);
  return {
    overallPercent: data?.overallPercent ?? null,
    status: data?.status ?? "no-data",
    nextClass: data?.nextClass ?? null,
    loading,
    error: error ?? null,
  };
}
