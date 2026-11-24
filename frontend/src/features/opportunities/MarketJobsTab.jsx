import { useState } from "react";
import { Globe, RefreshCw, Search } from "lucide-react";
import DriveGrid from "../../components/DriveGrid.jsx";
import { listMarketCategories, listMarketJobs, listMarketSources } from "../../lib/api/jobFeed.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { EmptyState, ErrorState, LoadingState, useAsync } from "../../ui/index.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import JobActions from "./JobActions.jsx";
import { patchJobs, sourceLabel } from "./jobVM.js";
import { JOB_TYPE_OPTIONS, WORK_TYPE_OPTIONS } from "./labels.js";
import Pager from "./Pager.jsx";

const PAGE_SIZE = 10;

function FilterSelect({ label, value, onChange, options, allLabel = "Any" }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] font-extrabold uppercase">{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)} className="input-stark w-full text-base sm:text-xs">
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** OPEN MARKET: GET /job-feed with filters, pagination, source labels, save / apply. */
export default function MarketJobsTab() {
  const { params, setParams } = usePanel("jobs.market");
  const page = params.page ?? 1;
  const [freshJobs, setFreshJobs] = useState(0);

  const jobs = useAsync(
    () =>
      listMarketJobs({
        query: params.query,
        category: params.category,
        jobType: params.jobType,
        workType: params.workType,
        location: params.location,
        source: params.source,
        sort: params.sort,
        page,
        limit: PAGE_SIZE,
      }),
    [params.query, params.category, params.jobType, params.workType, params.location, params.source, params.sort, page],
  );
  const categories = useAsync(listMarketCategories, []);
  const sources = useAsync(listMarketSources, []);

  useSocketEvent("job-feed:updated", (payload) => {
    const inserted = Number(payload?.inserted);
    setFreshJobs((count) => count + (Number.isFinite(inserted) && inserted > 0 ? inserted : 1));
  });

  const update = (patch) => setParams({ ...patch, page: undefined, highlightIds: undefined });
  const submit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update({
      query: String(form.get("query") || "").trim() || undefined,
      location: String(form.get("location") || "").trim() || undefined,
    });
  };
  const refresh = () => {
    setFreshJobs(0);
    jobs.reload();
    categories.reload();
  };

  const categoryOptions = (categories.data ?? []).map((entry) => ({ value: entry.value, label: `${entry.value} (${entry.count ?? 0})` }));
  const sourceOptions = (sources.data ?? [])
    .filter((entry) => entry.count > 0 || entry.name === params.source)
    .map((entry) => ({ value: entry.name, label: `${entry.label || sourceLabel(entry.name)}${Number.isFinite(entry.count) ? ` (${entry.count})` : ""}` }));
  const hasFilters = Boolean(params.query || params.category || params.jobType || params.workType || params.location || params.source);
  const items = jobs.data?.items ?? [];
  const total = jobs.data?.total;

  return (
    <div className="space-y-3">
      <div className="space-y-2 border-[1.5px] border-black bg-gray-50 p-3">
        <form key={`${params.query ?? ""}|${params.location ?? ""}`} onSubmit={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_auto]">
          <label className="relative block">
            <span className="sr-only">Search jobs</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
            <input name="query" defaultValue={params.query ?? ""} placeholder="Title, company, skill…" className="input-stark w-full pl-8 text-base sm:text-xs" />
          </label>
          <label className="block">
            <span className="sr-only">Location</span>
            <input name="location" defaultValue={params.location ?? ""} placeholder="Location (e.g. Bengaluru)" className="input-stark w-full text-base sm:text-xs" />
          </label>
          <button type="submit" className="btn-primary min-h-11 justify-center px-3 py-1.5 text-xs sm:min-h-0">
            SEARCH
          </button>
        </form>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <FilterSelect label="Job type" value={params.jobType} onChange={(jobType) => update({ jobType })} options={JOB_TYPE_OPTIONS} />
          <FilterSelect label="Work type" value={params.workType} onChange={(workType) => update({ workType })} options={WORK_TYPE_OPTIONS} />
          <FilterSelect label="Category" value={params.category} onChange={(category) => update({ category })} options={categoryOptions} />
          <FilterSelect label="Source" value={params.source} onChange={(source) => update({ source })} options={sourceOptions} />
          <FilterSelect
            label="Sort"
            value={params.sort === "match" ? "match" : ""}
            onChange={(sort) => update({ sort: sort === "match" ? "match" : undefined })}
            options={[{ value: "match", label: "Best match for me" }]}
            allLabel="Newest first"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase text-gray-600 tabular-nums">
            {Number.isFinite(total) ? `${total} job${total === 1 ? "" : "s"}` : ""}
          </span>
          {hasFilters && (
            <button
              type="button"
              onClick={() => update({ query: undefined, category: undefined, jobType: undefined, workType: undefined, location: undefined, source: undefined })}
              className="btn-secondary px-2 py-1 text-[10px]"
            >
              CLEAR FILTERS
            </button>
          )}
        </div>
      </div>

      {freshJobs > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-2 border-black bg-yellow-100 px-3 py-2">
          <span className="text-[11px] font-black uppercase">
            {freshJobs} new job{freshJobs === 1 ? "" : "s"} in the feed
          </span>
          <button type="button" onClick={refresh} className="btn-primary min-h-11 px-3 py-1 text-[11px] sm:min-h-0">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            REFRESH
          </button>
        </div>
      )}

      {jobs.error && !jobs.data ? (
        <ErrorState error={jobs.error} title="COULD NOT LOAD THE JOB FEED" onRetry={jobs.reload} />
      ) : jobs.loading && !jobs.data ? (
        <LoadingState label="LOADING JOBS…" />
      ) : (
        <>
          {jobs.loading && <div className="text-[10px] font-black uppercase text-gray-500">Refreshing…</div>}
          <DriveGrid
            jobs={items}
            highlightIds={params.highlightIds}
            onOpen={(job) => openPanel("jobs.detail", { jobId: job.id, source: "market", from: "market" })}
            renderActions={(job) => (
              <JobActions
                job={job}
                from="market"
                onChange={(patch) => jobs.setData((previous) => (previous ? { ...previous, items: patchJobs(previous.items, job.id, patch) } : previous))}
              />
            )}
            empty={
              <EmptyState
                icon={Globe}
                title={hasFilters ? "No jobs match these filters" : "The job feed is empty"}
                text={hasFilters ? "Try fewer filters or a broader search." : "Jobs from the open market appear here after the next feed sync."}
              />
            }
          />
          <Pager
            page={page}
            hasNextPage={Boolean(jobs.data?.hasNextPage)}
            total={total}
            pageSize={PAGE_SIZE}
            onChange={(next) => setParams({ page: next > 1 ? next : undefined })}
          />
        </>
      )}
    </div>
  );
}
