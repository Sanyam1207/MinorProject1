import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileText, Gift, History, LoaderCircle, RefreshCw, UserRoundCheck } from "lucide-react";
import {
  bulkUpdateApplicationStatus,
  exportApplicationsCsv,
  getApplication,
  getApplicationResumeUrl,
  listApplicants,
  listApplications,
  listDrives,
  updateApplicationStatus,
} from "../../lib/api/admin.js";
import { useSocketEvent } from "../../lib/realtime.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Panel,
  StatusBadge,
  Tabs,
  formatDate,
  formatDateTime,
  toastError,
  toastSuccess,
  useAsync,
} from "../../ui/index.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import { downloadBlob, openAsyncUrl } from "./browser.js";
import OfferForm from "./OfferForm.jsx";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  OFFERABLE_STATUSES,
  STAFF_SETTABLE_STATUSES,
  isoDay,
  slug,
  sumCounts,
} from "./mappers.js";
import { DataTable, SearchBox, SelectBox, Td } from "./parts.jsx";

const PAGE_SIZE = 50;
const SORTS = [
  { value: "recent", label: "Newest first" },
  { value: "cgpa", label: "CGPA (high → low)" },
  { value: "name", label: "Name" },
  { value: "status", label: "Pipeline stage" },
];
const ELIGIBILITY_COLORS = { eligible: "bg-green-200", ineligible: "bg-red-100", incomplete: "bg-yellow-100", override: "bg-purple-100", unknown: "bg-gray-100" };

const isLocked = (application) => !STAFF_SETTABLE_STATUSES.includes(application.status);

const openResume = async (application) => {
  try {
    await openAsyncUrl(async () => (await getApplicationResumeUrl(application._id))?.url);
  } catch (error) {
    toastError(error?.code === "RESUME_NOT_FOUND" ? "This applicant has no resume attached." : error, "Could not open the resume");
  }
};

function StatusSelect({ application, onChange, disabled }) {
  if (isLocked(application)) {
    return <StatusBadge kind="application" status={application.status}>{APPLICATION_STATUS_LABELS[application.status]?.toUpperCase()}</StatusBadge>;
  }
  return (
    <select
      value={application.status}
      disabled={disabled}
      aria-label={`Status for ${application.student?.name}`}
      onChange={(event) => onChange(application, event.target.value)}
      className="input-stark py-1 text-base font-bold sm:text-[11px]"
    >
      {STAFF_SETTABLE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {APPLICATION_STATUS_LABELS[status]}
        </option>
      ))}
    </select>
  );
}

function ApplicationDetail({ application, scope, onClose, onStatus, onOffer, busy }) {
  const [status, setStatus] = useState(application.status);
  const [note, setNote] = useState("");
  const snapshot = application.eligibilitySnapshot;
  const student = application.student || {};
  return (
    <Modal
      open
      size="lg"
      title={student.name || "APPLICATION"}
      onClose={onClose}
      footer={
        <>
          {application.resume && (
            <button type="button" onClick={() => openResume(application)} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" /> RESUME
            </button>
          )}
          {OFFERABLE_STATUSES.includes(application.status) && (
            <button type="button" onClick={() => onOffer(application)} className="btn-secondary min-h-11 bg-green-200 px-3 py-1.5 text-xs sm:min-h-0">
              <Gift className="h-3.5 w-3.5" aria-hidden="true" /> MAKE OFFER
            </button>
          )}
          {scope !== "company" && application.offer?._id && (
            <button type="button" onClick={() => openPanel("tpo.offers", { offerId: application.offer._id })} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              VIEW OFFER
            </button>
          )}
          <button type="button" onClick={onClose} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            DONE
          </button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div><div className="text-[9px] font-black uppercase text-gray-500">Email</div><div className="break-all font-mono text-[11px]">{student.email || "—"}</div></div>
          <div><div className="text-[9px] font-black uppercase text-gray-500">Roll no.</div><div className="font-mono text-[11px]">{student.rollNumber || student.ggsipuEnrollment || "—"}</div></div>
          <div><div className="text-[9px] font-black uppercase text-gray-500">Branch / year</div><div className="font-semibold">{student.branch || "—"} · {student.passingYear || "—"}</div></div>
          <div><div className="text-[9px] font-black uppercase text-gray-500">CGPA / backlogs</div><div className="font-semibold tabular-nums">{student.cgpa ?? "—"} / {student.activeBacklogs ?? "—"}</div></div>
        </div>
        <div className="border-2 border-black p-2">
          <div className="font-black uppercase">{application.job?.companyName} — {application.job?.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge kind="application" status={application.status}>{APPLICATION_STATUS_LABELS[application.status]?.toUpperCase()}</StatusBadge>
            <span className="text-[11px] font-semibold text-gray-600">Applied {formatDateTime(application.appliedAt)} · via {application.source}</span>
            {application.offer && <StatusBadge kind="offer" status={application.offer.status}>OFFER {application.offer.status?.toUpperCase()} {application.offer.packageLpa ? `· ${application.offer.packageLpa} LPA` : ""}</StatusBadge>}
          </div>
        </div>
        {student.skills?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {student.skills.map((skill) => <span key={skill} className="badge-stark bg-gray-100 text-[9px]">{skill}</span>)}
          </div>
        )}
        {application.coverNote && <p className="whitespace-pre-wrap border-l-4 border-black bg-gray-50 p-2 font-medium">{application.coverNote}</p>}

        {snapshot && (
          <div>
            <div className="mb-1 flex items-center gap-2 font-black uppercase">
              Eligibility at apply
              <span className={`badge-stark text-[9px] uppercase ${ELIGIBILITY_COLORS[snapshot.status] ?? "bg-gray-100"}`}>{snapshot.status}</span>
            </div>
            {snapshot.checks?.length > 0 ? (
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {snapshot.checks.map((check) => (
                  <li key={check.key} className={`border border-black p-1.5 text-[11px] font-semibold ${check.passed === false ? "bg-red-50" : check.passed ? "bg-green-50" : "bg-gray-50"}`}>
                    <b>{check.label}</b>: needs {String(check.required ?? "—")}, has {String(check.actual ?? "—")}
                  </li>
                ))}
              </ul>
            ) : snapshot.reasons?.length ? (
              <ul className="list-disc pl-5 font-semibold">{snapshot.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            ) : (
              <p className="font-semibold text-gray-600">No eligibility details recorded.</p>
            )}
            {application.eligibilityOverride && (
              <p className="mt-1 text-[11px] font-semibold text-purple-800">
                Override by {application.eligibilityOverride.byName}: {application.eligibilityOverride.note}
              </p>
            )}
          </div>
        )}

        {!isLocked(application) && (
          <div className="border-2 border-black bg-gray-50 p-2">
            <div className="mb-2 font-black uppercase">Move to stage</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr_auto]">
              <select value={status} onChange={(event) => setStatus(event.target.value)} className="input-stark text-base sm:text-xs" aria-label="New status">
                {STAFF_SETTABLE_STATUSES.map((value) => <option key={value} value={value}>{APPLICATION_STATUS_LABELS[value]}</option>)}
              </select>
              <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Note to the student (optional)" className="input-stark text-base sm:text-xs" />
              <button
                type="button"
                disabled={busy || status === application.status}
                onClick={() => onStatus(application, status, note.trim())}
                className="btn-primary min-h-11 justify-center px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0"
              >
                {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} UPDATE
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 flex items-center gap-1 font-black uppercase"><History className="h-3.5 w-3.5" aria-hidden="true" /> Timeline</div>
          {application.timeline?.length ? (
            <ol className="space-y-1 border-l-2 border-black pl-3">
              {[...application.timeline].reverse().map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="text-[11px]">
                  <span className="font-black uppercase">{APPLICATION_STATUS_LABELS[entry.status] ?? entry.status}</span>{" "}
                  <span className="font-semibold text-gray-600">{formatDateTime(entry.at)}{entry.byName ? ` · ${entry.byName}` : ""}</span>
                  {entry.note && <div className="font-medium text-gray-800">{entry.note}</div>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="font-semibold text-gray-600">No history yet.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Applicants for the TPO (`tpo.applicants`) and a recruiter's drives (`company.applicants`). */
export default function ApplicantsPanel({ scope = "tpo" }) {
  const isCompany = scope === "company";
  const panelId = isCompany ? "company.applicants" : "tpo.applicants";
  const { params, setParams } = usePanel(panelId);
  const jobId = params.jobId ?? "";
  const statusFilter = params.status ?? "all";

  const [filters, setFilters] = useState({ branch: "", passingYear: "", q: "", eligible: "", sort: "recent" });
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState({ status: "shortlisted", note: "" });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [offerFor, setOfferFor] = useState(null);

  // Reset paging / selection when the drive or filters change ("adjust state while rendering").
  const filterKey = JSON.stringify([jobId, statusFilter, filters]);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
    setSelected(new Set());
  }

  const drives = useAsync(() => listDrives({ status: "all" }), [refreshKey]);
  const query = { ...filters, status: statusFilter === "all" ? undefined : statusFilter, page, limit: PAGE_SIZE };
  const { data, error, loading, reload, setData } = useAsync(
    () => (jobId ? listApplicants(jobId, query) : listApplications(query)),
    [jobId, statusFilter, filters.branch, filters.passingYear, filters.q, filters.eligible, filters.sort, page, refreshKey],
  );
  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refresh = () => setRefreshKey((key) => key + 1);
  useSocketEvent("placement:applicants", (payload) => {
    if (!jobId || !payload?.jobId || payload.jobId === jobId) refresh();
  });
  useSocketEvent("placement:offers", refresh);

  const listed = params.applicationId ? items.find((item) => item._id === params.applicationId) : null;
  // Deep links (notifications, copilot) may point at an application outside the current page.
  const fetched = useAsync(
    () => (params.applicationId && !listed ? getApplication(params.applicationId) : Promise.resolve(null)),
    [params.applicationId, Boolean(listed), refreshKey],
  );
  const detail = listed ?? (fetched.data?._id === params.applicationId ? fetched.data : null);
  const job = data?.job ?? (drives.data?.items ?? []).find((drive) => drive._id === jobId) ?? null;

  const statusTabs = [
    { id: "all", label: "all", count: sumCounts(data?.statusCounts) },
    ...APPLICATION_STATUSES.map((status) => ({ id: status, label: APPLICATION_STATUS_LABELS[status], count: data?.statusCounts?.[status] ?? 0 })),
  ];

  const patchItem = (application) => {
    if (!application?._id) return;
    setData((current) => (current ? { ...current, items: current.items.map((item) => (item._id === application._id ? application : item)) } : current));
  };

  const changeStatus = async (application, status, note) => {
    setBusy(true);
    try {
      const result = await updateApplicationStatus(application._id, { status, note: note || undefined });
      patchItem(result.application);
      toastSuccess(result.changed ? `${application.student?.name || "Applicant"} → ${APPLICATION_STATUS_LABELS[status]}` : "No change");
      refresh();
    } catch (failure) {
      toastError(failure, "Could not update the status");
    } finally {
      setBusy(false);
    }
  };

  const applyBulk = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const result = await bulkUpdateApplicationStatus({ applicationIds: [...selected], status: bulk.status, note: bulk.note.trim() || undefined });
      const parts = [`${result.updated} updated`];
      if (result.unchanged) parts.push(`${result.unchanged} unchanged`);
      if (result.failed.length) parts.push(`${result.failed.length} failed`);
      if (result.failed.length) toastError(`${parts.join(", ")}. ${result.failed[0]?.message ?? ""}`);
      else toastSuccess(parts.join(", "));
      setSelected(new Set());
      setBulk((current) => ({ ...current, note: "" }));
      refresh();
    } catch (failure) {
      toastError(failure, "Bulk update failed");
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await exportApplicationsCsv({ jobId: jobId || undefined, ...filters, status: statusFilter === "all" ? undefined : statusFilter });
      const name = job ? `applicants-${slug(job.companyName)}-${slug(job.title)}-${isoDay()}.csv` : `applicants-${isoDay()}.csv`;
      downloadBlob(blob, name);
    } catch (failure) {
      toastError(failure, "Could not export the CSV");
    } finally {
      setExporting(false);
    }
  };

  const selectable = items.filter((item) => !isLocked(item));
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item._id));
  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setFilter = (key) => (value) => setFilters((current) => ({ ...current, [key]: value }));

  const actions = (
    <>
      <button type="button" onClick={refresh} aria-label="Refresh applicants" className="btn-secondary px-2 py-1 text-[10px]">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" onClick={exportCsv} disabled={exporting} className="btn-secondary px-2 py-1 text-[10px] disabled:opacity-50">
        {exporting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />} CSV
      </button>
    </>
  );

  return (
    <Panel title={isCompany ? "Applicants" : "Applicant review"} icon={UserRoundCheck} badge={`${total} ${total === 1 ? "APPLICANT" : "APPLICANTS"}`} actions={actions}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <SelectBox
            label="Drive"
            value={jobId}
            onChange={(value) => setParams({ ...params, jobId: value || undefined, applicationId: undefined }, { replace: true })}
            options={[
              { value: "", label: drives.loading && !drives.data ? "Loading drives…" : "All drives" },
              ...(drives.data?.items ?? []).map((drive) => ({ value: drive._id, label: `${drive.companyName} — ${drive.title} (${drive.applicantCount ?? 0}) · ${drive.status}` })),
            ]}
          />
          <SearchBox value={filters.q} onSearch={setFilter("q")} placeholder="Name, email, roll no." />
        </div>
        {job && (
          <div className="flex flex-wrap items-center gap-2 border-2 border-black bg-gray-50 p-2 text-[11px] font-semibold">
            <b className="uppercase">{job.companyName} — {job.title}</b>
            <span>Deadline {formatDate(job.applicationDeadline)}</span>
            <span className="badge-stark text-[9px] uppercase">{job.status}</span>
            <button type="button" onClick={() => openPanel(isCompany ? "company.drives" : "tpo.drives", { jobId: job._id })} className="ml-auto underline">
              View drive
            </button>
          </div>
        )}
        <Tabs tabs={statusTabs} value={statusFilter} onChange={(id) => setParams({ ...params, status: id === "all" ? undefined : id }, { replace: true })} label="Application status" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input value={filters.branch} onChange={(event) => setFilter("branch")(event.target.value)} placeholder="Branch" aria-label="Branch" className="input-stark text-base sm:text-xs" />
          <input value={filters.passingYear} onChange={(event) => setFilter("passingYear")(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="Passing year" aria-label="Passing year" className="input-stark text-base sm:text-xs" />
          <SelectBox
            label="Eligibility"
            value={filters.eligible}
            onChange={setFilter("eligible")}
            options={[{ value: "", label: "Any eligibility" }, { value: "true", label: "Eligible at apply" }, { value: "false", label: "Not eligible" }]}
          />
          <SelectBox label="Sort" value={filters.sort} onChange={setFilter("sort")} options={SORTS} />
        </div>

        {selected.size > 0 && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-2 border-black bg-yellow-100 p-2">
            <span className="text-xs font-black uppercase">{selected.size} selected</span>
            <select value={bulk.status} onChange={(event) => setBulk({ ...bulk, status: event.target.value })} aria-label="Bulk status" className="input-stark py-1 text-base sm:text-xs">
              {STAFF_SETTABLE_STATUSES.map((status) => <option key={status} value={status}>{APPLICATION_STATUS_LABELS[status]}</option>)}
            </select>
            <input value={bulk.note} onChange={(event) => setBulk({ ...bulk, note: event.target.value })} maxLength={500} placeholder="Note (optional)" aria-label="Bulk note" className="input-stark min-w-0 flex-1 py-1 text-base sm:text-xs" />
            <button type="button" onClick={applyBulk} disabled={busy} className="btn-primary px-3 py-1 text-xs disabled:opacity-50">
              {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} APPLY
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="btn-secondary px-3 py-1 text-xs">CLEAR</button>
          </div>
        )}

        {loading && !data ? (
          <LoadingState label="LOADING APPLICANTS…" />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <EmptyState icon={UserRoundCheck} title="No applicants" text={jobId ? "Nobody matches these filters for this drive yet." : "Pick a drive or change the filters."} />
        ) : (
          <DataTable head={[
            <input key="all" type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item._id)))} className="h-4 w-4 accent-white" />,
            "Student", "Branch / year", "CGPA", ...(jobId ? [] : ["Drive"]), "Eligible", "Status", "Applied", "",
          ]}
          >
            {items.map((application) => {
              const student = application.student || {};
              const snapshotStatus = application.eligibilitySnapshot?.status ?? "unknown";
              return (
                <tr key={application._id} className={selected.has(application._id) ? "bg-yellow-50" : "hover:bg-gray-50"}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${student.name}`}
                      disabled={isLocked(application)}
                      checked={selected.has(application._id)}
                      onChange={() => toggle(application._id)}
                      className="h-4 w-4 accent-black"
                    />
                  </Td>
                  <Td>
                    <button type="button" onClick={() => setParams({ ...params, applicationId: application._id }, { replace: true })} className="text-left">
                      <div className="font-black uppercase hover:underline">{student.name}</div>
                      <div className="font-mono text-[10px] text-gray-600">{student.rollNumber || student.email}</div>
                    </button>
                  </Td>
                  <Td className="whitespace-nowrap font-semibold">{student.branch || "—"}<div className="text-[10px] text-gray-600">{student.passingYear || "—"}</div></Td>
                  <Td className="font-bold tabular-nums">{student.cgpa ?? "—"}</Td>
                  {!jobId && <Td className="min-w-32 font-semibold">{application.job?.companyName}<div className="text-[10px] text-gray-600">{application.job?.title}</div></Td>}
                  <Td><span className={`badge-stark text-[9px] uppercase ${ELIGIBILITY_COLORS[snapshotStatus] ?? "bg-gray-100"}`}>{snapshotStatus}</span></Td>
                  <Td><StatusSelect application={application} onChange={changeStatus} disabled={busy} /></Td>
                  <Td className="whitespace-nowrap tabular-nums">{formatDate(application.appliedAt)}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => setParams({ ...params, applicationId: application._id }, { replace: true })} aria-label="Details and timeline" className="btn-secondary px-1.5 py-1">
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      {application.resume && (
                        <button type="button" onClick={() => openResume(application)} aria-label="Open resume" className="btn-secondary px-1.5 py-1">
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                      {OFFERABLE_STATUSES.includes(application.status) && (
                        <button type="button" onClick={() => setOfferFor(application)} aria-label="Make offer" className="btn-secondary bg-green-200 px-1.5 py-1">
                          <Gift className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </DataTable>
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

      {detail && (
        <ApplicationDetail
          key={`${detail._id}:${detail.status}`}
          application={detail}
          scope={scope}
          busy={busy}
          onClose={() => setParams({ ...params, applicationId: undefined }, { replace: true })}
          onStatus={changeStatus}
          onOffer={(application) => setOfferFor(application)}
        />
      )}
      <OfferForm
        open={Boolean(offerFor)}
        application={offerFor}
        onClose={() => setOfferFor(null)}
        onCreated={() => {
          setOfferFor(null);
          refresh();
        }}
      />
    </Panel>
  );
}
