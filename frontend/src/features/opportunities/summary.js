// StudentMode tile counts (FRONTEND.md §11.1, §13.3). Cached for 60 s across
// mounts; never throws (a failed part counts as 0).
import { useState } from "react";
import { useSelector } from "react-redux";
import { listCampusJobs, listMyApplications, listMyOffers, listMyTraining } from "../../lib/api/placements.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { selectLatestJobs } from "../../store/aiChatSlice.js";
import { useAsync } from "../../ui/useAsync.js";

const TTL_MS = 60_000;
const ACTIVE_APPLICATION = new Set(["applied", "shortlisted", "interview", "offered"]);
const ACTIVE_PROGRAM = new Set(["upcoming", "ongoing"]);

let cache = { at: 0, promise: null };

/** Drop the cached counts (call after apply / accept / register …). */
export function invalidateOpportunitySummary() {
  cache = { at: 0, promise: null };
}

const valueOf = (result, count) => (result.status === "fulfilled" ? count(result.value) : 0);

function loadSummary() {
  const now = Date.now();
  if (cache.promise && now - cache.at < TTL_MS) return cache.promise;
  const promise = Promise.allSettled([
    listCampusJobs({ limit: 200 }),
    listMyApplications(),
    listMyOffers(),
    listMyTraining(),
  ]).then(([campus, applications, offers, training]) => {
    const failed = [campus, applications, offers, training].filter((result) => result.status === "rejected");
    return {
      campusCount: valueOf(campus, (data) => data.items.filter((job) => job.isOpen !== false).length),
      applicationsActive: valueOf(applications, (list) => list.filter((item) => ACTIVE_APPLICATION.has(item.status)).length),
      offersPending: valueOf(offers, (list) => list.filter((offer) => offer.status === "extended").length),
      trainingUpcoming: valueOf(training, (list) => list.filter((entry) => ACTIVE_PROGRAM.has(entry.program?.status)).length),
      error: failed.length === 4 ? failed[0].reason ?? new Error("Could not load opportunities") : null,
    };
  });
  cache = { at: now, promise };
  return promise;
}

/** → { campusCount, aiMatches, applicationsActive, offersPending, trainingUpcoming, loading, error } */
export function useOpportunitySummary() {
  const latestJobs = useSelector(selectLatestJobs);
  const [version, setVersion] = useState(0);
  const refresh = () => {
    invalidateOpportunitySummary();
    setVersion((value) => value + 1);
  };
  useSocketEvent("placement:application", refresh);
  useSocketEvent("placement:offer", refresh);
  useSocketEvent("placement:training", refresh);

  const { data, loading } = useAsync(loadSummary, [version]);
  return {
    campusCount: data?.campusCount ?? 0,
    aiMatches: Array.isArray(latestJobs) ? latestJobs.length : 0,
    applicationsActive: data?.applicationsActive ?? 0,
    offersPending: data?.offersPending ?? 0,
    trainingUpcoming: data?.trainingUpcoming ?? 0,
    loading: loading && !data,
    error: data?.error ?? null,
  };
}
