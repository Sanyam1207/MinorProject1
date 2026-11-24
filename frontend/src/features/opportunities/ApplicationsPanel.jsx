import { useEffect, useState } from "react";
import { ClipboardList, Eye, FileText, Gift, Undo2 } from "lucide-react";
import { listMyApplications, withdrawApplication } from "../../lib/api/placements.js";
import { useSocketEvent } from "../../lib/realtime.js";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  StatusBadge,
  Tabs,
  toastError,
  toastSuccess,
  useAsync,
  useNow,
} from "../../ui/index.js";
import { formatDate, formatDateTime, formatRelative } from "../../ui/format.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import { APPLICATION_LABELS, WITHDRAWABLE, applicationColorKey } from "./labels.js";
import { invalidateOpportunitySummary } from "./summary.js";

const FILTERS = [
  { id: "all", label: "ALL", match: () => true },
  { id: "active", label: "IN PROGRESS", match: (status) => WITHDRAWABLE.has(status) },
  { id: "offered", label: "OFFERS", match: (status) => status === "offered" || status === "hired" },
  { id: "rejected", label: "NOT SELECTED", match: (status) => status === "rejected" },
  { id: "withdrawn", label: "WITHDRAWN", match: (status) => status === "withdrawn" },
];

/** `params.status` may be a filter id or a raw application status. */
const filterFor = (status) => {
  if (!status) return "all";
  if (FILTERS.some((filter) => filter.id === status)) return status;
  if (WITHDRAWABLE.has(status)) return "active";
  if (status === "hired") return "offered";
  return "all";
};

const label = (status) => (APPLICATION_LABELS[status] ?? status ?? "").toUpperCase();

function Timeline({ entries }) {
  if (!entries.length) return null;
  return (
    <ol className="relative ml-1.5 space-y-2 border-l-2 border-black pl-4">
      {entries.map((entry, index) => (
        <li key={`${entry.status}-${entry.at ?? index}`} className="relative">
          <span aria-hidden="true" className="absolute -left-[1.4rem] top-1 h-2.5 w-2.5 border-2 border-black bg-white" />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="application" status={applicationColorKey(entry.status)}>
              {label(entry.status)}
            </StatusBadge>
            <span className="text-[10px] font-bold text-gray-500">{formatDateTime(entry.at)}</span>
          </div>
          {entry.note && <p className="mt-0.5 text-[11px] font-medium text-gray-700">{entry.note}</p>}
        </li>
      ))}
    </ol>
  );
}

function ApplicationCard({ application, highlighted, onWithdraw }) {
  const now = useNow(60000);
  const [open, setOpen] = useState(highlighted);
  const job = application.job;
  const canWithdraw = WITHDRAWABLE.has(application.status);

  return (
    <article
      id={`application-${application._id}`}
      className={`card-stark flex min-w-0 flex-col gap-3 bg-white ${highlighted ? "outline outline-4 outline-yellow-300" : ""}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-extrabold uppercase text-gray-600">{job.companyName}</div>
          <h4 className="break-words text-sm font-black uppercase leading-tight">{job.title}</h4>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] font-bold text-gray-600">
            <span>{job.packageLabel}</span>
            {job.location && <span>{job.location}</span>}
            {job.driveDate && <span>Drive {formatDate(job.driveDate)}</span>}
          </div>
        </div>
        <StatusBadge kind="application" status={applicationColorKey(application.status)}>
          {(application.statusLabel || label(application.status)).toUpperCase()}
        </StatusBadge>
      </header>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold uppercase text-gray-500">
        <span>Applied {formatRelative(application.appliedAt, now)}</span>
        {application.updatedAt && <span>Updated {formatRelative(application.updatedAt, now)}</span>}
        {application.resume?.title && (
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" aria-hidden="true" />
            {application.resume.title}
          </span>
        )}
      </div>

      {application.coverNote && (
        <p className="border-l-4 border-gray-300 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-700">{application.coverNote}</p>
      )}

      {application.timeline.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="text-[10px] font-black uppercase underline underline-offset-2"
          >
            {open ? "Hide timeline" : `Show timeline (${application.timeline.length})`}
          </button>
          {open && (
            <div className="mt-2">
              <Timeline entries={application.timeline} />
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t-[1.5px] border-black pt-3">
        {job._id && job.title !== "Drive removed" && (
          <button
            type="button"
            onClick={() => openPanel("jobs.detail", { jobId: job._id, source: "campus" })}
            className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            VIEW DRIVE
          </button>
        )}
        {application.offer?._id && (
          <button
            type="button"
            onClick={() => openPanel("offers", { offerId: application.offer._id })}
            className="btn-primary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0"
          >
            <Gift className="h-3.5 w-3.5" aria-hidden="true" />
            VIEW OFFER
          </button>
        )}
        {canWithdraw && (
          <button
            type="button"
            onClick={() => onWithdraw(application)}
            className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] text-red-700 sm:min-h-0"
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            WITHDRAW
          </button>
        )}
      </div>
    </article>
  );
}

/** ApplicationsPanel — StudentMode `applications` (usePanel("applications") {status, applicationId}). */
export default function ApplicationsPanel() {
  const { params, setParams } = usePanel("applications");
  const applications = useAsync(() => listMyApplications(), []);
  useSocketEvent("placement:application", () => applications.reload());
  const [withdrawing, setWithdrawing] = useState(null);
  const [busy, setBusy] = useState(false);

  const filter = filterFor(params.status);
  const highlightId = params.applicationId ?? null;
  const all = applications.data ?? [];
  const matcher = FILTERS.find((entry) => entry.id === filter)?.match ?? (() => true);
  const visible = all.filter((application) => matcher(application.status) || application._id === highlightId);
  const hasHighlight = Boolean(highlightId) && all.some((application) => application._id === highlightId);

  useEffect(() => {
    if (!hasHighlight) return;
    document.getElementById(`application-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasHighlight, highlightId]);

  const confirmWithdraw = async () => {
    if (!withdrawing) return;
    setBusy(true);
    try {
      const updated = await withdrawApplication(withdrawing._id);
      invalidateOpportunitySummary();
      toastSuccess("Application withdrawn");
      applications.setData((previous) =>
        (previous ?? []).map((application) => (application._id === withdrawing._id ? updated ?? { ...application, status: "withdrawn" } : application)),
      );
      setWithdrawing(null);
    } catch (error) {
      toastError(error, "Could not withdraw the application");
    } finally {
      setBusy(false);
    }
  };

  const tabs = FILTERS.map((entry) => ({ id: entry.id, label: entry.label, count: all.filter((application) => entry.match(application.status)).length }));

  return (
    <Panel title="My applications" icon={ClipboardList} badge={applications.data ? `${all.length} TOTAL` : undefined}>
      <Tabs label="Application filter" tabs={tabs} value={filter} onChange={(id) => setParams({ status: id === "all" ? undefined : id })} className="mb-4" />
      {applications.error && !applications.data ? (
        <ErrorState error={applications.error} title="COULD NOT LOAD YOUR APPLICATIONS" onRetry={applications.reload} />
      ) : !applications.data ? (
        <LoadingState label="LOADING APPLICATIONS…" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={all.length ? "Nothing in this filter" : "No applications yet"}
          text={all.length ? "Pick another filter to see the rest." : "Apply to a campus drive and follow every step here."}
          action={
            !all.length && (
              <button type="button" onClick={() => openPanel("jobs.campus")} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
                BROWSE CAMPUS DRIVES
              </button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map((application) => (
            <ApplicationCard
              key={application._id}
              application={application}
              highlighted={application._id === highlightId}
              onWithdraw={setWithdrawing}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(withdrawing)}
        title="WITHDRAW APPLICATION?"
        body={
          withdrawing
            ? `Your application for ${withdrawing.job.title} at ${withdrawing.job.companyName} will be withdrawn. You can re-apply later only while the drive is still open.`
            : ""
        }
        confirmLabel="WITHDRAW"
        danger
        busy={busy}
        onConfirm={confirmWithdraw}
        onCancel={() => setWithdrawing(null)}
      />
    </Panel>
  );
}
