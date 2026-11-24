import { useEffect, useState } from "react";
import { Bookmark, ExternalLink, Eye, LoaderCircle, Save, Trash2 } from "lucide-react";
import { TRACKER_STATUSES, listSavedJobs, removeSavedJob, saveMarketJob } from "../../lib/api/jobFeed.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, StatusBadge, Tabs, toastError, toastSuccess, useAsync, useNow } from "../../ui/index.js";
import { formatDate, formatRelative } from "../../ui/format.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import { TRACKER_LABELS, safeUrl, typeLabel } from "./labels.js";

const NOTES_MAX = 2000;

function TrackerItem({ entry, highlighted, onUpdated, onRemoved }) {
  const now = useNow(60000);
  const [notes, setNotes] = useState(entry.notes);
  const [busy, setBusy] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const job = entry.vm;
  const url = safeUrl(job.applicationUrl);
  const dirty = notes !== entry.notes;

  const save = async (patch, label) => {
    setBusy(label);
    try {
      const item = await saveMarketJob(entry.jobId, patch);
      onUpdated(item ?? { ...entry, ...patch });
      toastSuccess(label === "notes" ? "Notes saved" : `Moved to ${TRACKER_LABELS[patch.status] ?? patch.status}`);
    } catch (error) {
      toastError(error, "Could not update this job");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await removeSavedJob(entry.jobId);
      toastSuccess("Removed from your tracker");
      onRemoved(entry);
    } catch (error) {
      toastError(error, "Could not remove this job");
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  return (
    <article
      id={`tracker-${entry.jobId}`}
      className={`card-stark flex min-w-0 flex-col gap-3 bg-white ${highlighted ? "outline outline-4 outline-yellow-300" : ""}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-extrabold uppercase text-gray-600">{job.companyName}</div>
          <h4 className="break-words text-sm font-black uppercase leading-tight">{job.roleTitle}</h4>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] font-bold text-gray-600">
            {job.location && <span>{job.location}</span>}
            {[typeLabel(job.jobType), typeLabel(job.workType)].filter(Boolean).length > 0 && (
              <span>{[typeLabel(job.jobType), typeLabel(job.workType)].filter(Boolean).join(" · ")}</span>
            )}
            {job.salaryText && <span>{job.salaryText}</span>}
          </div>
          {job.sourceLabels.length > 0 && <div className="mt-0.5 text-[10px] font-semibold text-gray-500">via {job.sourceLabels.join(", ")}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge kind="tracker" status={entry.status}>
            {(TRACKER_LABELS[entry.status] ?? entry.status).toUpperCase()}
          </StatusBadge>
          {!entry.jobAvailable && <span className="badge-stark bg-orange-100 text-[10px]">NO LONGER IN THE FEED</span>}
        </div>
      </header>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold uppercase text-gray-500">
        <span>Saved {formatRelative(entry.savedAt, now)}</span>
        {entry.appliedAt && <span>Applied {formatDate(entry.appliedAt)}</span>}
        {entry.statusChangedAt && <span>Updated {formatRelative(entry.statusChangedAt, now)}</span>}
      </div>

      <label className="block">
        <span className="mb-1 block text-[10px] font-extrabold uppercase">Status</span>
        <select
          value={entry.status}
          disabled={Boolean(busy)}
          onChange={(event) => save({ status: event.target.value }, "status")}
          className="input-stark w-full text-base sm:w-auto sm:text-xs"
        >
          {TRACKER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {TRACKER_LABELS[status]}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 flex justify-between text-[10px] font-extrabold uppercase">
          Notes
          <span className="font-bold text-gray-500 tabular-nums">
            {notes.length}/{NOTES_MAX}
          </span>
        </span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, NOTES_MAX))}
          rows={3}
          placeholder="Interview dates, contacts, follow-ups…"
          className="input-stark w-full text-base sm:text-xs"
        />
      </label>

      {entry.history.length > 1 && (
        <ol className="flex flex-wrap items-center gap-1 text-[10px] font-bold uppercase text-gray-600" aria-label="Status history">
          {entry.history.map((step, index) => (
            <li key={`${step.status}-${step.at ?? index}`} className="inline-flex items-center gap-1">
              {index > 0 && <span aria-hidden="true">→</span>}
              <span title={step.at ? formatDate(step.at) : undefined}>{TRACKER_LABELS[step.status] ?? step.status}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t-[1.5px] border-black pt-3">
        {dirty && (
          <button type="button" onClick={() => save({ notes }, "notes")} disabled={Boolean(busy)} className="btn-primary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0">
            {busy === "notes" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
            SAVE NOTES
          </button>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            APPLICATION PAGE
          </a>
        )}
        {entry.jobAvailable && (
          <button
            type="button"
            onClick={() => openPanel("jobs.detail", { jobId: entry.jobId, source: "market", from: "tracker" })}
            className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            DETAILS
          </button>
        )}
        <button
          type="button"
          onClick={() => setConfirmRemove(true)}
          disabled={Boolean(busy)}
          className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] text-red-700 sm:min-h-0"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          REMOVE
        </button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="REMOVE FROM TRACKER?"
        body={`${job.roleTitle} at ${job.companyName} and your notes will be removed from your tracker.`}
        confirmLabel="REMOVE"
        danger
        busy={busy === "remove"}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </article>
  );
}

/** SAVED: the open-market tracker (saved → applied → interviewing → offer / rejected). */
export default function TrackerTab() {
  const { params, setParams } = usePanel("jobs.tracker");
  const status = params.status ?? null;
  const saved = useAsync(() => listSavedJobs({ status: status ?? undefined, limit: 100 }), [status]);
  useSocketEvent("job-feed:updated", () => saved.reload());

  const highlightId = params.highlightId ?? null;
  const items = saved.data?.items ?? [];
  const targetJobId = highlightId ? items.find((entry) => entry.jobId === highlightId || entry.id === highlightId)?.jobId ?? null : null;
  useEffect(() => {
    if (!targetJobId) return;
    document.getElementById(`tracker-${targetJobId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [targetJobId]);

  const counts = saved.data?.counts ?? {};
  const tabs = [
    { id: "all", label: "ALL", count: Number.isFinite(counts.total) ? counts.total : undefined },
    ...TRACKER_STATUSES.map((value) => ({ id: value, label: TRACKER_LABELS[value].toUpperCase(), count: counts[value] })),
  ];

  const replaceItem = (item) =>
    saved.setData((previous) => {
      if (!previous) return previous;
      const before = previous.items.find((entry) => entry.jobId === item.jobId);
      const nextCounts = { ...previous.counts };
      if (before && before.status !== item.status) {
        nextCounts[before.status] = Math.max(0, (nextCounts[before.status] ?? 1) - 1);
        nextCounts[item.status] = (nextCounts[item.status] ?? 0) + 1;
      }
      const itemsNext = previous.items
        .map((entry) => (entry.jobId === item.jobId ? item : entry))
        .filter((entry) => !status || entry.status === status);
      return { ...previous, items: itemsNext, counts: nextCounts };
    });
  const dropItem = (item) =>
    saved.setData((previous) => {
      if (!previous) return previous;
      const nextCounts = { ...previous.counts };
      nextCounts[item.status] = Math.max(0, (nextCounts[item.status] ?? 1) - 1);
      nextCounts.total = Math.max(0, (nextCounts.total ?? 1) - 1);
      return { ...previous, items: previous.items.filter((entry) => entry.jobId !== item.jobId), counts: nextCounts };
    });

  return (
    <div className="space-y-3">
      <Tabs
        label="Tracker status"
        tabs={tabs}
        value={status ?? "all"}
        onChange={(value) => setParams({ status: value === "all" ? undefined : value, highlightId: undefined })}
      />
      {saved.error && !saved.data ? (
        <ErrorState error={saved.error} title="COULD NOT LOAD YOUR TRACKER" onRetry={saved.reload} />
      ) : saved.loading && !saved.data ? (
        <LoadingState label="LOADING YOUR TRACKER…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title={status ? `Nothing marked ${TRACKER_LABELS[status].toLowerCase()}` : "No saved jobs yet"}
          text="Save open-market jobs to track them from saved to offer, with your own notes."
          action={
            <button type="button" onClick={() => openPanel("jobs.market")} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              BROWSE OPEN-MARKET JOBS
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((entry) => (
            <TrackerItem
              key={`${entry.jobId}:${entry.updatedAt ?? ""}`}
              entry={entry}
              highlighted={highlightId === entry.jobId || highlightId === entry.id}
              onUpdated={replaceItem}
              onRemoved={dropItem}
            />
          ))}
        </div>
      )}
    </div>
  );
}
