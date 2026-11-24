import { useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw, Rss, Zap } from "lucide-react";
import { getJobFeedSyncStatus, listMarketJobs, triggerJobFeedSync } from "../../lib/api/admin.js";
import { useSocketEvent } from "../../lib/realtime.js";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  Tabs,
  formatDateTime,
  formatRelative,
  toastError,
  toastInfo,
  toastSuccess,
  useAsync,
  useNow,
} from "../../ui/index.js";
import { usePanel } from "../../workspace/index.js";
import { ColorBadge, DataTable, KpiTile, SearchBox, SelectBox, Td } from "./parts.jsx";

const RUN_COLORS = { running: "bg-yellow-100", ok: "bg-green-200", partial: "bg-orange-100", failed: "bg-red-100" };
const WA_COLORS = { connected: "bg-green-200", "waiting-for-link": "bg-yellow-100", starting: "bg-yellow-100", reconnecting: "bg-orange-100", disabled: "bg-gray-100", unavailable: "bg-red-100", stopped: "bg-gray-200" };
const JOB_TYPES = ["", "full-time", "part-time", "internship", "contract"];
const WORK_TYPES = ["", "onsite", "remote", "hybrid"];

const duration = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

function RunResults({ run }) {
  if (!run?.results?.length) return <p className="text-[11px] font-semibold text-gray-600">No per-source results{run?.status === "running" ? " yet" : ""}.</p>;
  return (
    <DataTable head={["Source", "Received", "New", "Duplicates", "Skipped", "Time", "Error"]}>
      {run.results.map((result) => (
        <tr key={result.source} className={result.error ? "bg-red-50" : ""}>
          <Td className="font-black uppercase">{result.label || result.source}</Td>
          <Td className="tabular-nums">{result.received}</Td>
          <Td className="font-bold tabular-nums">{result.inserted}</Td>
          <Td className="tabular-nums">{result.duplicates}</Td>
          <Td className="tabular-nums">{result.skipped}</Td>
          <Td className="whitespace-nowrap tabular-nums">{duration(result.durationMs)}</Td>
          <Td className="max-w-64 break-words text-[10px] font-semibold text-red-800">{result.error || "—"}</Td>
        </tr>
      ))}
    </DataTable>
  );
}

function StatusView({ status, highlightRunId, now }) {
  const [openRun, setOpenRun] = useState(highlightRunId ?? null);
  const runs = status.recentRuns ?? [];
  const totals = status.totals ?? {};
  const schedule = status.schedule ?? {};
  const whatsapp = status.whatsapp ?? {};
  const shownRun = runs.find((run) => run.id === openRun) ?? status.current ?? runs[0] ?? null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiTile label="Jobs in feed" value={totals.jobs ?? 0} hint={`${totals.sampleJobs ?? 0} sample`} />
        <KpiTile label="New (24 h)" value={totals.newLast24h ?? 0} accent="bg-green-50" />
        <KpiTile label="Saved by students" value={totals.savedJobs ?? 0} accent="bg-blue-50" />
        <KpiTile
          label="Last success"
          value={status.lastSuccessfulRun ? formatRelative(status.lastSuccessfulRun.finishedAt || status.lastSuccessfulRun.startedAt, now) : "Never"}
          hint={status.lastRun ? `Last run: ${status.lastRun.status}` : undefined}
          accent={status.lastRun?.status === "failed" ? "bg-red-50" : "bg-white"}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="border-2 border-black p-3">
          <h4 className="mb-2 text-xs font-black uppercase">Schedule</h4>
          {schedule.enabled ? (
            <p className="text-xs font-semibold">
              Every <b>{schedule.intervalMinutes} min</b>. Next run {schedule.nextRunAt ? <b>{formatRelative(schedule.nextRunAt, now)}</b> : "after the first run"}.
              {schedule.onBoot ? " Also runs at server start." : ""}
            </p>
          ) : (
            <p className="text-xs font-semibold text-gray-700">Automatic sync is off{schedule.intervalMinutes ? "" : " (no interval set)"}. Use SYNC NOW.</p>
          )}
        </section>
        <section className="border-2 border-black p-3">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase">
            WhatsApp listener <ColorBadge color={WA_COLORS[whatsapp.state] ?? "bg-gray-100"}>{whatsapp.state || "disabled"}</ColorBadge>
          </h4>
          {whatsapp.enabled ? (
            <p className="text-xs font-semibold">
              {whatsapp.channels ?? 0} channels · extractor {whatsapp.extractor || "—"} · last post {whatsapp.lastPostAt ? formatRelative(whatsapp.lastPostAt, now) : "never"}
              <br />
              Posts: {whatsapp.posts?.saved ?? 0} saved, {whatsapp.posts?.ignored ?? 0} ignored, {whatsapp.posts?.failed ?? 0} failed
              {whatsapp.reason ? <><br /><span className="text-red-800">{whatsapp.reason}</span></> : null}
            </p>
          ) : (
            <p className="text-xs font-semibold text-gray-700">Not enabled on this server.</p>
          )}
        </section>
      </div>

      <section className="border-2 border-black p-3">
        <h4 className="mb-2 text-xs font-black uppercase">Sources</h4>
        <DataTable head={["Source", "Kind", "Enabled", "Jobs", "Last synced", "Last error"]}>
          {(status.sources ?? []).map((source) => (
            <tr key={source.name} className={source.lastError ? "bg-red-50" : ""}>
              <Td className="font-black uppercase">{source.label || source.name}</Td>
              <Td className="text-[10px] uppercase">{source.kind || "—"}</Td>
              <Td>{source.enabled ? "Yes" : "No"}</Td>
              <Td className="tabular-nums">{source.count ?? 0}</Td>
              <Td className="whitespace-nowrap">{source.lastSyncedAt ? formatRelative(source.lastSyncedAt, now) : "—"}</Td>
              <Td className="max-w-64 break-words text-[10px] font-semibold text-red-800">{source.lastError || "—"}</Td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section className="border-2 border-black p-3">
        <h4 className="mb-2 text-xs font-black uppercase">Recent runs</h4>
        {runs.length === 0 ? (
          <p className="text-[11px] font-semibold text-gray-600">No sync has run yet.</p>
        ) : (
          <ul className="mb-3 space-y-1">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setOpenRun(run.id)}
                  className={`flex w-full flex-wrap items-center gap-2 border border-black p-2 text-left text-[11px] font-semibold ${shownRun?.id === run.id ? "bg-gray-100" : "bg-white hover:bg-gray-50"} ${highlightRunId === run.id ? "outline-2 outline-offset-1 outline-black" : ""}`}
                >
                  <ColorBadge color={RUN_COLORS[run.status] ?? "bg-gray-100"}>{run.status}</ColorBadge>
                  <span className="tabular-nums">{formatDateTime(run.startedAt)}</span>
                  <span className="uppercase text-gray-600">{run.trigger}{run.triggeredBy?.name ? ` · ${run.triggeredBy.name}` : ""}</span>
                  <span className="ml-auto tabular-nums">+{run.totals?.inserted ?? 0} new · {duration(run.durationMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {shownRun && (
          <>
            {shownRun.error && <p className="mb-2 border border-black bg-red-50 p-2 text-[11px] font-bold text-red-800">{shownRun.error}</p>}
            <RunResults run={shownRun} />
          </>
        )}
      </section>
    </div>
  );
}

function FeedBrowser({ params, setParams }) {
  const filters = {
    query: params.query ?? "",
    jobType: params.jobType ?? "",
    workType: params.workType ?? "",
    location: params.location ?? "",
    source: params.source ?? "",
    category: params.category ?? "",
    sort: params.sort ?? "newest",
  };
  const [page, setPage] = useState(1);
  const key = JSON.stringify(filters);
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setPage(1);
  }
  const { data, error, loading, reload } = useAsync(() => listMarketJobs({ ...filters, page, limit: 20 }), [key, page]);
  const set = (name) => (value) => setParams({ [name]: value || undefined });
  const jobs = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SearchBox value={filters.query} onSearch={set("query")} placeholder="Search title, company, skill" className="sm:col-span-2" />
        <SelectBox label="Job type" value={filters.jobType} onChange={set("jobType")} options={JOB_TYPES.map((value) => ({ value, label: value || "Any job type" }))} />
        <SelectBox label="Work type" value={filters.workType} onChange={set("workType")} options={WORK_TYPES.map((value) => ({ value, label: value || "Any work type" }))} />
      </div>
      {loading && !data ? (
        <LoadingState label="LOADING FEED…" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : jobs.length === 0 ? (
        <EmptyState icon={Rss} title="No jobs match" text="Try a different search or run a sync." />
      ) : (
        <>
          <p className="text-[11px] font-bold text-gray-600">{total} jobs</p>
          <ul className="space-y-2">
            {jobs.map((job) => (
              <li key={job.id} className="border-2 border-black p-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-black uppercase">{job.title || "Untitled role"}</div>
                    <div className="text-[11px] font-semibold text-gray-700">
                      {job.company || "Company not listed"}{job.location ? ` · ${job.location}` : ""}{job.salary ? ` · ${job.salary}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {job.isNew && <ColorBadge color="bg-green-200">new</ColorBadge>}
                    {job.isSample && <ColorBadge color="bg-orange-100">sample</ColorBadge>}
                    {job.jobType && <ColorBadge>{job.jobType}</ColorBadge>}
                    {job.workType && <ColorBadge>{job.workType}</ColorBadge>}
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold text-gray-600">
                  <span>{(job.sources || []).join(", ")}</span>
                  <span>{formatDateTime(job.postedAt)}</span>
                  {job.applyUrl && (
                    <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 font-black uppercase text-black underline">
                      Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {data?.page && total > 20 && (
            <div className="flex items-center justify-between text-xs font-bold">
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="btn-secondary px-2 py-1 disabled:opacity-40">PREV</button>
              <span className="tabular-nums">Page {page} / {Math.ceil(total / 20)}</span>
              <button type="button" disabled={page >= Math.ceil(total / 20)} onClick={() => setPage((value) => value + 1)} className="btn-secondary px-2 py-1 disabled:opacity-40">NEXT</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Open-market job feed admin (`tpo.job-feed`): sync status, runs, sources, WhatsApp and a read-only feed browser. */
export default function JobFeedAdminPanel() {
  const { params, setParams } = usePanel("tpo.job-feed");
  const hasFeedFilters = Boolean(params.query || params.jobType || params.workType || params.location || params.source || params.category);
  const [tab, setTab] = useState(hasFeedFilters && !params.runId ? "feed" : "status");
  const [confirming, setConfirming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const now = useNow(30000);
  const { data: status, error, loading, reload, setData } = useAsync(() => getJobFeedSyncStatus(), []);

  useSocketEvent("job-feed:sync", (payload) => {
    const run = payload?.run;
    if (run) {
      setData((current) => {
        if (!current) return current;
        const running = run.status === "running";
        const recentRuns = [run, ...(current.recentRuns ?? []).filter((item) => item.id !== run.id)].slice(0, 10);
        return { ...current, running, current: running ? run : null, recentRuns };
      });
      if (run.status !== "running") {
        reload();
        if (run.status === "failed") toastError("Job feed sync failed");
        else toastSuccess(`Job feed sync finished: +${run.totals?.inserted ?? 0} new jobs`);
      }
    } else {
      reload();
    }
  });

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { run, alreadyRunning } = await triggerJobFeedSync();
      setConfirming(false);
      if (alreadyRunning) toastInfo("A sync is already running");
      else toastSuccess("Sync started");
      if (run) setData((current) => (current ? { ...current, running: true, current: run, recentRuns: [run, ...(current.recentRuns ?? []).filter((item) => item.id !== run.id)].slice(0, 10) } : current));
    } catch (failure) {
      toastError(failure, "Could not start the sync");
    } finally {
      setSyncing(false);
    }
  };

  const running = Boolean(status?.running);

  return (
    <Panel
      title="Job feed (market)"
      icon={Rss}
      badge={running ? "SYNC RUNNING" : status ? "IDLE" : undefined}
      actions={
        <>
          <button type="button" onClick={reload} aria-label="Refresh status" className="btn-secondary px-2 py-1 text-[10px]">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setConfirming(true)} disabled={running || syncing} className="btn-primary px-2 py-1 text-[10px] disabled:opacity-50">
            {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
            {running ? "SYNCING…" : "SYNC NOW"}
          </button>
        </>
      }
    >
      <Tabs
        className="mb-3"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "status", label: "Sync status" },
          { id: "feed", label: "Browse feed", count: status?.totals?.jobs },
        ]}
      />
      {tab === "feed" ? (
        <FeedBrowser params={params} setParams={setParams} />
      ) : loading && !status ? (
        <LoadingState label="LOADING SYNC STATUS…" />
      ) : error && !status ? (
        <ErrorState error={error} onRetry={reload} />
      ) : status ? (
        <StatusView key={params.runId ?? "none"} status={status} highlightRunId={params.runId} now={now} />
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="SYNC THE JOB FEED NOW?"
        body="Fetches new jobs from every enabled source. It runs in the background and usually takes under a minute."
        confirmLabel="SYNC NOW"
        busy={syncing}
        onConfirm={syncNow}
        onCancel={() => setConfirming(false)}
      />
    </Panel>
  );
}
