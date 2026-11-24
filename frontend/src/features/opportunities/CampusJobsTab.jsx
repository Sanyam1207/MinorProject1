import { useState } from "react";
import { Building2, Search } from "lucide-react";
import DriveGrid from "../../components/DriveGrid.jsx";
import { listCampusJobs } from "../../lib/api/placements.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { EmptyState, ErrorState, LoadingState, useAsync } from "../../ui/index.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import JobActions from "./JobActions.jsx";
import { patchJobs } from "./jobVM.js";
import Pager from "./Pager.jsx";

const PAGE_SIZE = 20;
const SORTS = [
  { value: "deadline", label: "Deadline (soonest)" },
  { value: "match", label: "Best match" },
  { value: "package", label: "Highest package" },
  { value: "recent", label: "Newest" },
];

/** CAMPUS: GET /jobs with server eligibility, match %, my application; in-portal apply. */
export default function CampusJobsTab() {
  const { params, setParams } = usePanel("jobs.campus");
  const [sort, setSort] = useState("deadline");
  const filterKey = JSON.stringify([params.query, params.location, params.minPackageLpa, params.eligibleOnly, sort]);
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;

  const jobs = useAsync(
    () =>
      listCampusJobs({
        query: params.query,
        location: params.location,
        minPackageLpa: params.minPackageLpa,
        eligibleOnly: params.eligibleOnly,
        sort,
        page,
        limit: PAGE_SIZE,
      }),
    [filterKey, page],
  );
  useSocketEvent("placement:application", () => jobs.reload());

  const submit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const minPackage = String(form.get("minPackageLpa") || "").trim();
    setParams({
      query: String(form.get("query") || "").trim() || undefined,
      location: String(form.get("location") || "").trim() || undefined,
      minPackageLpa: minPackage === "" ? undefined : Number(minPackage),
    });
  };

  const hasFilters = Boolean(params.query || params.location || params.minPackageLpa || params.eligibleOnly);
  const items = jobs.data?.items ?? [];

  return (
    <div className="space-y-3">
      <form
        key={`${params.query ?? ""}|${params.location ?? ""}|${params.minPackageLpa ?? ""}`}
        onSubmit={submit}
        className="grid grid-cols-1 gap-2 border-[1.5px] border-black bg-gray-50 p-3 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_auto]"
      >
        <label className="relative block">
          <span className="sr-only">Search drives</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
          <input name="query" defaultValue={params.query ?? ""} placeholder="Role, company or skill" className="input-stark w-full pl-8 text-base sm:text-xs" />
        </label>
        <label className="block">
          <span className="sr-only">Location</span>
          <input name="location" defaultValue={params.location ?? ""} placeholder="Location" className="input-stark w-full text-base sm:text-xs" />
        </label>
        <label className="block">
          <span className="sr-only">Minimum package (LPA)</span>
          <input
            name="minPackageLpa"
            type="number"
            min="0"
            max="500"
            step="0.5"
            inputMode="decimal"
            defaultValue={params.minPackageLpa ?? ""}
            placeholder="Min LPA"
            className="input-stark w-full text-base sm:text-xs"
          />
        </label>
        <button type="submit" className="btn-primary min-h-11 justify-center px-3 py-1.5 text-xs sm:min-h-0">
          SEARCH
        </button>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 xl:col-span-4">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[11px] font-extrabold uppercase sm:min-h-0">
            <input
              type="checkbox"
              checked={Boolean(params.eligibleOnly)}
              onChange={(event) => setParams({ eligibleOnly: event.target.checked ? true : undefined })}
              className="h-4 w-4 accent-black"
            />
            Eligible only
          </label>
          <label className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase">
            Sort
            <select value={sort} onChange={(event) => setSort(event.target.value)} className="input-stark py-1 text-base sm:text-xs">
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {hasFilters && (
            <button
              type="button"
              onClick={() => setParams({ query: undefined, location: undefined, minPackageLpa: undefined, eligibleOnly: undefined })}
              className="btn-secondary px-2 py-1 text-[10px]"
            >
              CLEAR FILTERS
            </button>
          )}
        </div>
      </form>

      {jobs.error && !jobs.data ? (
        <ErrorState error={jobs.error} title="COULD NOT LOAD DRIVES" onRetry={jobs.reload} />
      ) : jobs.loading && !jobs.data ? (
        <LoadingState label="LOADING DRIVES…" />
      ) : (
        <>
          {jobs.loading && <div className="text-[10px] font-black uppercase text-gray-500">Refreshing…</div>}
          <DriveGrid
            jobs={items}
            onOpen={(job) => openPanel("jobs.detail", { jobId: job.id, source: "campus", from: "campus" })}
            renderActions={(job) => (
              <JobActions
                job={job}
                from="campus"
                onChange={(patch) => jobs.setData((previous) => (previous ? { ...previous, items: patchJobs(previous.items, job.id, patch) } : previous))}
              />
            )}
            empty={
              <EmptyState
                icon={Building2}
                title={hasFilters ? "No drives match these filters" : "No campus drives yet"}
                text={
                  hasFilters
                    ? "Try a broader search or clear the filters."
                    : "Your placement office has not published any drives for you yet. New drives appear here and in your notifications."
                }
              />
            }
          />
          <Pager page={page} hasNextPage={Boolean(jobs.data?.hasNextPage)} onChange={(next) => setPageState({ key: filterKey, page: next })} />
        </>
      )}
    </div>
  );
}
