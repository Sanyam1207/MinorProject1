import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Lock,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { approveDrive, closeDrive, deleteDrive, getDrive, listDrives, publishDrive, rejectDrive } from "../../lib/api/admin.js";
import { useSocketEvent } from "../../lib/realtime.js";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  Tabs,
  formatDate,
  formatDateTime,
  formatLpa,
  toastError,
  toastSuccess,
  useAsync,
} from "../../ui/index.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import AnnouncementForm from "./AnnouncementForm.jsx";
import DriveForm from "./DriveForm.jsx";
import { APPLICATION_STATUSES, APPLICATION_STATUS_LABELS, DRIVE_STATUSES, DRIVE_STATUS_COLORS } from "./mappers.js";
import { ColorBadge, KeyValue, SearchBox } from "./parts.jsx";

const TAB_ORDER = ["all", "pending", "active", "draft", "closed", "rejected"];

const canEdit = (scope, drive) => scope !== "company" || ["draft", "pending", "rejected"].includes(drive.status);
const canDelete = (scope, drive) => (drive.applicantCount ?? 0) === 0 && (scope !== "company" || !["active", "closed"].includes(drive.status));
const canClose = (drive) => drive.status === "active" || drive.status === "pending" || drive.status === "draft";

function DriveStatus({ status }) {
  return <ColorBadge color={DRIVE_STATUS_COLORS[status] ?? "bg-gray-100"}>{status || "unknown"}</ColorBadge>;
}

function CountsStrip({ counts }) {
  if (!counts) return null;
  const entries = APPLICATION_STATUSES.filter((status) => counts[status] > 0);
  if (entries.length === 0) return <span className="text-[10px] font-semibold text-gray-500">No applicants yet</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map((status) => (
        <span key={status} className="border border-black bg-white px-1 text-[9px] font-black uppercase tabular-nums">
          {APPLICATION_STATUS_LABELS[status]} {counts[status]}
        </span>
      ))}
    </div>
  );
}

function DriveActions({ scope, drive, onAction, compact = false }) {
  const size = compact ? "px-2 py-1 text-[10px]" : "min-h-11 px-3 py-1.5 text-xs sm:min-h-0";
  const isTpo = scope !== "company";
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={() => onAction("applicants", drive)} className={`btn-primary ${size}`}>
        <Users className="h-3.5 w-3.5" aria-hidden="true" /> APPLICANTS ({drive.applicantCount ?? 0})
      </button>
      {isTpo && drive.status === "pending" && (
        <>
          <button type="button" onClick={() => onAction("approve", drive)} className={`btn-secondary bg-green-200 ${size}`}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> APPROVE
          </button>
          <button type="button" onClick={() => onAction("reject", drive)} className={`btn-secondary bg-red-100 ${size}`}>
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> REJECT
          </button>
        </>
      )}
      {isTpo && (drive.status === "draft" || drive.status === "rejected" || drive.status === "closed") && (
        <button type="button" onClick={() => onAction("publish", drive)} className={`btn-secondary ${size}`}>
          <Send className="h-3.5 w-3.5" aria-hidden="true" /> {drive.status === "closed" ? "REOPEN" : "PUBLISH"}
        </button>
      )}
      {canEdit(scope, drive) && (
        <button type="button" onClick={() => onAction("edit", drive)} className={`btn-secondary ${size}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> EDIT
        </button>
      )}
      {canClose(drive) && (
        <button type="button" onClick={() => onAction("close", drive)} className={`btn-secondary ${size}`}>
          <Lock className="h-3.5 w-3.5" aria-hidden="true" /> CLOSE
        </button>
      )}
      {canDelete(scope, drive) && (
        <button type="button" onClick={() => onAction("delete", drive)} className={`btn-secondary text-red-700 ${size}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> DELETE
        </button>
      )}
    </div>
  );
}

function DriveCardRow({ scope, drive, onOpen, onAction }) {
  return (
    <li className={`border-2 border-black bg-white p-3 ${drive.status === "pending" && scope !== "company" ? "bg-yellow-50" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button type="button" onClick={() => onOpen(drive)} className="min-w-0 text-left">
          <div className="truncate text-sm font-black uppercase hover:underline">{drive.title}</div>
          <div className="text-[11px] font-bold text-gray-700">
            {drive.companyName} · {formatLpa(drive.packageLabel || drive.packageLpa)} {drive.location ? `· ${drive.location}` : ""}
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-1">
          {scope !== "company" && drive.createdByRole === "company" && <ColorBadge color="bg-purple-100">recruiter</ColorBadge>}
          <DriveStatus status={drive.status} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-gray-700">
        <span>Deadline: <b className="tabular-nums">{formatDate(drive.applicationDeadline)}</b></span>
        <span>Drive: <b className="tabular-nums">{formatDate(drive.driveDate)}</b></span>
        {drive.minimumCgpa != null && <span>CGPA ≥ <b>{drive.minimumCgpa}</b></span>}
      </div>
      <div className="mt-2">
        <CountsStrip counts={drive.statusCounts} />
      </div>
      <div className="mt-3 border-t border-black pt-2">
        <DriveActions scope={scope} drive={drive} onAction={onAction} compact />
      </div>
    </li>
  );
}

function DriveDetail({ scope, jobId, fallback, onBack, onAction, refreshKey }) {
  const { data, error, loading, reload } = useAsync(() => getDrive(jobId), [jobId, refreshKey]);
  const drive = data ?? fallback;
  if (loading && !drive) return <LoadingState label="LOADING DRIVE…" />;
  if (error && !drive) return <ErrorState error={error} onRetry={reload} />;
  if (!drive) return null;
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="btn-secondary px-3 py-1.5 text-xs">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> ALL DRIVES
      </button>
      <div className="border-2 border-black p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="text-base font-black uppercase tracking-tight">{drive.title}</h4>
            <p className="text-xs font-bold text-gray-700">{drive.companyName}</p>
          </div>
          <DriveStatus status={drive.status} />
        </div>
        {drive.review && (
          <p className={`mt-2 border border-black p-2 text-[11px] font-bold ${drive.review.decision === "rejected" ? "bg-red-50" : "bg-green-50"}`}>
            {drive.review.decision === "rejected" ? "Rejected" : "Approved"} by {drive.review.byName || "placement office"} on {formatDateTime(drive.review.at)}
            {drive.review.note ? ` — “${drive.review.note}”` : ""}
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KeyValue label="Package">{formatLpa(drive.packageLabel || drive.packageLpa)}</KeyValue>
          <KeyValue label="Location">{drive.location || "—"}</KeyValue>
          <KeyValue label="Type">{drive.employmentType || "—"}</KeyValue>
          <KeyValue label="Applicants">{drive.applicantCount ?? 0}</KeyValue>
          <KeyValue label="Deadline">{formatDateTime(drive.applicationDeadline)}</KeyValue>
          <KeyValue label="Drive date">{formatDate(drive.driveDate)}</KeyValue>
          <KeyValue label="Created by">{drive.createdBy?.name || "—"} ({drive.createdByRole})</KeyValue>
          <KeyValue label="Published">{formatDate(drive.publishedAt)}</KeyValue>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-black pt-3 sm:grid-cols-4">
          <KeyValue label="Min CGPA">{drive.minimumCgpa ?? "Any"}</KeyValue>
          <KeyValue label="Max backlogs">{drive.maximumBacklogs ?? "Any"}</KeyValue>
          <KeyValue label="Min 10th / 12th">{drive.min10thPercentage ?? "—"}% / {drive.min12thPercentage ?? "—"}%</KeyValue>
          <KeyValue label="Graduation years">{drive.graduationYears?.length ? drive.graduationYears.join(", ") : "Any"}</KeyValue>
          <KeyValue label="Branches">{drive.eligibleBranches?.length ? drive.eligibleBranches.join(", ") : "All"}</KeyValue>
          <KeyValue label="Skills">{drive.skills?.length ? drive.skills.join(", ") : "—"}</KeyValue>
        </div>
        <div className="mt-3">
          <CountsStrip counts={drive.statusCounts} />
        </div>
        {drive.description && <p className="mt-3 whitespace-pre-wrap border-t border-black pt-3 text-xs font-medium">{drive.description}</p>}
        {drive.selectionProcess && (
          <p className="mt-2 whitespace-pre-wrap text-[11px] font-semibold text-gray-700">
            <b>Selection process:</b> {drive.selectionProcess}
          </p>
        )}
        {drive.rounds?.length > 0 && (
          <ol className="mt-3 space-y-1">
            {drive.rounds.map((round, index) => (
              <li key={round._id ?? index} className="flex flex-wrap items-center gap-2 border border-black p-2 text-[11px] font-semibold">
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                <b className="uppercase">{round.name}</b>
                <span>{formatDateTime(round.at)}</span>
                <span className="badge-stark text-[9px] uppercase">{round.mode}</span>
                {round.venue && <span>{round.venue}</span>}
                {round.notes && <span className="text-gray-600">{round.notes}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      <DriveActions scope={scope} drive={drive} onAction={onAction} />
    </div>
  );
}

/** Placement drives for the TPO (`tpo.drives`) and a recruiter's own drives (`company.drives`). */
export default function DrivesPanel({ scope = "tpo" }) {
  const isCompany = scope === "company";
  const panelId = isCompany ? "company.drives" : "tpo.drives";
  const { params, setParams } = usePanel(panelId);
  const statusFilter = DRIVE_STATUSES.includes(params.status) ? params.status : "all";
  const query = params.query ?? "";
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [announcing, setAnnouncing] = useState(false);

  const { data, error, loading, reload, setData } = useAsync(() => listDrives({ status: "all", query }), [query, refreshKey]);
  const drives = useMemo(() => data?.items ?? [], [data]);

  useSocketEvent("placement:job", () => setRefreshKey((key) => key + 1));
  useSocketEvent("placement:applicants", () => setRefreshKey((key) => key + 1));

  const counts = useMemo(() => {
    const result = { all: drives.length };
    for (const status of DRIVE_STATUSES) result[status] = drives.filter((drive) => drive.status === status).length;
    return result;
  }, [drives]);
  const visible = statusFilter === "all" ? drives : drives.filter((drive) => drive.status === statusFilter);
  const tabs = TAB_ORDER.filter((id) => id === "all" || counts[id] > 0 || id === statusFilter || id === "active" || (!isCompany && id === "pending")).map((id) => ({
    id,
    label: id === "pending" && !isCompany ? "awaiting approval" : id,
    count: counts[id] ?? 0,
  }));

  const createOpen = Boolean(params.create) || editing !== null;
  const selected = params.jobId ? drives.find((drive) => drive._id === params.jobId) : null;

  const replaceDrive = (job) => {
    if (!job?._id) return;
    setData((current) => {
      if (!current) return current;
      const exists = current.items.some((item) => item._id === job._id);
      const items = exists ? current.items.map((item) => (item._id === job._id ? { ...item, ...job } : item)) : [job, ...current.items];
      return { ...current, items, total: items.length };
    });
  };

  const onAction = (kind, drive) => {
    if (kind === "applicants") {
      openPanel(isCompany ? "company.applicants" : "tpo.applicants", { jobId: drive._id });
      return;
    }
    if (kind === "edit") {
      setEditing(drive);
      return;
    }
    setConfirm({ kind, drive });
  };

  const runConfirm = async (reason) => {
    const { kind, drive } = confirm;
    setBusy(true);
    try {
      if (kind === "approve" || kind === "publish") {
        const { job, notifiedStudents } = await (kind === "approve" ? approveDrive : publishDrive)(drive._id, {});
        replaceDrive(job);
        toastSuccess(Number.isFinite(notifiedStudents) ? `Drive published. ${notifiedStudents} students notified.` : "Drive published");
      } else if (kind === "reject") {
        replaceDrive(await rejectDrive(drive._id, { note: reason }));
        toastSuccess("Drive rejected. The recruiter has been told why.");
      } else if (kind === "close") {
        replaceDrive(await closeDrive(drive._id, reason ? { reason } : {}));
        toastSuccess("Drive closed");
      } else if (kind === "delete") {
        await deleteDrive(drive._id);
        setData((current) => (current ? { ...current, items: current.items.filter((item) => item._id !== drive._id) } : current));
        if (params.jobId === drive._id) setParams({ ...params, jobId: undefined }, { replace: true });
        toastSuccess("Drive deleted");
      }
      setConfirm(null);
      setRefreshKey((key) => key + 1);
    } catch (failure) {
      toastError(failure, "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy = confirm
    ? {
      approve: { title: "APPROVE DRIVE?", body: `“${confirm.drive.title}” will be published and eligible students notified.`, label: "APPROVE" },
      publish: { title: "PUBLISH DRIVE?", body: `“${confirm.drive.title}” will become visible to eligible students.`, label: "PUBLISH" },
      reject: { title: "REJECT DRIVE?", body: "Tell the recruiter what to change. They can edit and resubmit.", label: "REJECT", danger: true, reason: true, reasonLabel: "Reason (3–500 characters)" },
      close: { title: "CLOSE DRIVE?", body: "No new applications will be accepted. Existing applicants stay in the pipeline.", label: "CLOSE DRIVE", danger: true },
      delete: { title: "DELETE DRIVE?", body: "This permanently removes the drive. Only drives without applications can be deleted.", label: "DELETE", danger: true },
    }[confirm.kind]
    : null;

  const header = (
    <>
      {!isCompany && (
        <button type="button" onClick={() => setAnnouncing(true)} className="btn-secondary px-2 py-1 text-[10px]">
          <Megaphone className="h-3.5 w-3.5" aria-hidden="true" /> ANNOUNCE
        </button>
      )}
      <button type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh drives" className="btn-secondary px-2 py-1 text-[10px]">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" onClick={() => setParams({ create: true })} className="btn-primary px-2 py-1 text-[10px]">
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {isCompany ? "POST A DRIVE" : "NEW DRIVE"}
      </button>
    </>
  );

  return (
    <Panel title={isCompany ? "My drives" : "Placement drives"} icon={Briefcase} badge={`${drives.length} TOTAL`} actions={header}>
      {params.jobId ? (
        <DriveDetail
          scope={scope}
          jobId={params.jobId}
          fallback={selected}
          refreshKey={refreshKey}
          onBack={() => setParams({ ...params, jobId: undefined }, { replace: true })}
          onAction={onAction}
        />
      ) : (
        <div className="space-y-3">
          {!isCompany && counts.pending > 0 && statusFilter !== "pending" && (
            <button
              type="button"
              onClick={() => setParams({ status: "pending" })}
              className="w-full border-2 border-black bg-yellow-100 p-2 text-left text-xs font-black uppercase hover:bg-yellow-200"
            >
              {counts.pending} recruiter drive{counts.pending === 1 ? "" : "s"} awaiting your approval →
            </button>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Tabs tabs={tabs} value={statusFilter} onChange={(id) => setParams({ status: id === "all" ? undefined : id })} label="Drive status" />
            <SearchBox value={query} onSearch={(text) => setParams({ query: text || undefined })} placeholder="Search title, company, skill" className="sm:w-72" />
          </div>
          {loading && !data ? (
            <LoadingState label="LOADING DRIVES…" />
          ) : error && !data ? (
            <ErrorState
              error={error}
              title={error?.code === "COMPANY_NOT_LINKED" ? "ACCOUNT NOT LINKED TO A COMPANY" : undefined}
              onRetry={reload}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title={query || statusFilter !== "all" ? "No drives match" : "No drives yet"}
              text={isCompany ? "Post a drive; the placement office reviews it before students see it." : "Create a drive or approve one posted by a recruiter."}
              action={
                <button type="button" onClick={() => setParams({ create: true })} className="btn-primary px-3 py-1.5 text-xs">
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {isCompany ? "POST A DRIVE" : "NEW DRIVE"}
                </button>
              }
            />
          ) : (
            <ul className="space-y-2">
              {visible.map((drive) => (
                <DriveCardRow key={drive._id} scope={scope} drive={drive} onOpen={(item) => setParams({ jobId: item._id })} onAction={onAction} />
              ))}
            </ul>
          )}
        </div>
      )}

      <DriveForm
        open={createOpen}
        scope={scope}
        drive={editing}
        onClose={() => {
          setEditing(null);
          if (params.create) setParams({ ...params, create: undefined }, { replace: true });
        }}
        onSaved={(job) => {
          replaceDrive(job);
          setEditing(null);
          const next = { ...params, create: undefined };
          if (job?._id && !editing) next.jobId = job._id;
          setParams(next, { replace: true });
          setRefreshKey((key) => key + 1);
        }}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirmCopy?.title}
        body={confirmCopy?.body}
        confirmLabel={confirmCopy?.label}
        danger={confirmCopy?.danger}
        requireReason={confirmCopy?.reason}
        reasonLabel={confirmCopy?.reasonLabel}
        busy={busy}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
      <AnnouncementForm open={announcing} onClose={() => setAnnouncing(false)} />
    </Panel>
  );
}
