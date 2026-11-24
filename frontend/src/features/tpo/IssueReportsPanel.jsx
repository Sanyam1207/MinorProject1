import { useState } from "react";
import { ChevronLeft, ChevronRight, Flag, LoaderCircle, RefreshCw } from "lucide-react";
import { listIssueReports, updateIssueReport } from "../../lib/api/admin.js";
import { EmptyState, ErrorState, LoadingState, Panel, Tabs, formatDateTime, formatRelative, toastError, toastSuccess, useAsync, useNow } from "../../ui/index.js";
import { usePanel } from "../../workspace/index.js";
import { ISSUE_STATUSES, ISSUE_STATUS_COLORS, humanize } from "./mappers.js";
import { ColorBadge, SearchBox } from "./parts.jsx";

const PAGE_SIZE = 20;

function ReportCard({ report, highlighted, now, onSaved }) {
  const [status, setStatus] = useState(report.status);
  const [note, setNote] = useState(report.note ?? "");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(highlighted);
  const dirty = status !== report.status || note !== (report.note ?? "");

  const save = async () => {
    setSaving(true);
    try {
      const patch = {};
      if (status !== report.status) patch.status = status;
      if (note !== (report.note ?? "")) patch.note = note;
      const updated = await updateIssueReport(report._id, patch);
      toastSuccess(report.user ? "Saved. The reporter was notified of the status change." : "Saved");
      onSaved(updated);
    } catch (failure) {
      toastError(failure, "Could not update the report");
    } finally {
      setSaving(false);
    }
  };

  const long = report.description.length > 280;
  return (
    <li className={`border-2 border-black p-3 ${highlighted ? "bg-yellow-50" : "bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-black uppercase">{report.user?.name || report.name}</div>
          <div className="break-all font-mono text-[10px] text-gray-600">
            {report.email}
            {report.role ? ` · ${report.role}` : report.user ? "" : " · not signed in"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ColorBadge color={ISSUE_STATUS_COLORS[report.status]}>{humanize(report.status)}</ColorBadge>
          <span className="text-[10px] font-semibold text-gray-600" title={formatDateTime(report.createdAt)}>{formatRelative(report.createdAt, now)}</span>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-xs font-medium">
        {long && !expanded ? `${report.description.slice(0, 280)}…` : report.description}
      </p>
      {long && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-[10px] font-black uppercase underline">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {report.page && <p className="mt-1 break-all text-[10px] font-semibold text-gray-600">Page: {report.page}</p>}
      <div className="mt-3 grid grid-cols-1 gap-2 border-t border-black pt-2 sm:grid-cols-[auto_1fr_auto]">
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status" className="input-stark text-base sm:text-xs">
          {ISSUE_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </select>
        <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Triage note (shown to the reporter)" aria-label="Note" className="input-stark text-base sm:text-xs" />
        <button type="button" onClick={save} disabled={!dirty || saving} className="btn-primary min-h-11 justify-center px-3 py-1.5 text-xs disabled:opacity-40 sm:min-h-0">
          {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} SAVE
        </button>
      </div>
      {report.resolvedAt && <p className="mt-1 text-[10px] font-semibold text-gray-600">Resolved {formatDateTime(report.resolvedAt)}</p>}
    </li>
  );
}

/** Issue inbox (`tpo.issues`): GET/PATCH /issue-reports. */
export default function IssueReportsPanel() {
  const { params, setParams } = usePanel("tpo.issues");
  const now = useNow(60000);
  const status = ISSUE_STATUSES.includes(params.status) ? params.status : params.status === "all" ? "all" : "open";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const key = `${status}|${search}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setPage(1);
  }

  const { data, error, loading, reload, setData } = useAsync(
    () => listIssueReports({ status, search: search || undefined, page, limit: PAGE_SIZE }),
    [status, search, page, refreshKey],
  );
  const counts = data?.counts ?? {};
  const items = data?.items ?? [];
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const notEnabled = error?.status === 404 && !data;

  const tabs = [
    ...ISSUE_STATUSES.map((value) => ({ id: value, label: humanize(value), count: counts[value] ?? 0 })),
    { id: "all", label: "All", count: Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0) },
  ];

  return (
    <Panel
      title="Issue reports"
      icon={Flag}
      badge={`${counts.open ?? 0} OPEN`}
      actions={
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="Refresh" className="btn-secondary px-2 py-1 text-[10px]">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      }
    >
      {notEnabled ? (
        <EmptyState icon={Flag} title="Issue inbox is not enabled on this server." />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Tabs tabs={tabs} value={status} onChange={(id) => setParams({ status: id })} label="Issue status" />
            <SearchBox value={search} onSearch={setSearch} placeholder="Name, email, text" className="sm:w-64" />
          </div>
          {loading && !data ? (
            <LoadingState label="LOADING REPORTS…" />
          ) : error && !data ? (
            <ErrorState error={error} onRetry={reload} />
          ) : items.length === 0 ? (
            <EmptyState icon={Flag} title="Nothing here" text={status === "open" ? "No open issues. Nice." : "No reports match."} />
          ) : (
            <ul className="space-y-2">
              {items.map((report) => (
                <ReportCard
                  key={`${report._id}:${report.updatedAt}`}
                  report={report}
                  now={now}
                  highlighted={params.reportId === report._id}
                  onSaved={(updated) => {
                    setData((current) => (current ? { ...current, items: current.items.map((item) => (item._id === updated._id ? updated : item)) } : current));
                    setRefreshKey((value) => value + 1);
                  }}
                />
              ))}
            </ul>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between text-xs font-bold">
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="btn-secondary px-2 py-1 disabled:opacity-40">
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> PREV
              </button>
              <span className="tabular-nums">Page {page} / {pages}</span>
              <button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)} className="btn-secondary px-2 py-1 disabled:opacity-40">
                NEXT <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
