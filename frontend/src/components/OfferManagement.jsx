import { useState } from "react";
import { BadgeCheck, Handshake, History, LoaderCircle, Plus, RefreshCw, ShieldAlert, Undo2 } from "lucide-react";
import { listOffers, markOfferPlaced, overrideOffer, revokeOffer } from "../lib/api/admin.js";
import { useSocketEvent } from "../lib/realtime.js";
import OfferForm from "../features/tpo/OfferForm.jsx";
import { OFFER_STATUSES, OFFER_STATUS_LABELS, sumCounts } from "../features/tpo/mappers.js";
import { ColorBadge, DataTable, KpiTile, SearchBox, Td } from "../features/tpo/parts.jsx";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Panel,
  StatusBadge,
  Tabs,
  formatDate,
  formatDateTime,
  formatLpa,
  toastError,
  toastSuccess,
  useAsync,
} from "../ui/index.js";
import { usePanel } from "../workspace/index.js";

const TYPE_COLORS = { normal: "bg-gray-100", dream: "bg-purple-100", "super-dream": "bg-purple-300" };

function OverrideDialog({ offer, onClose, onDone }) {
  const [newStatus, setNewStatus] = useState(OFFER_STATUSES.find((status) => status !== offer.status));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    if (note.trim().length < 3) {
      setError("Explain the override (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await overrideOffer(offer._id, { newStatus, note: note.trim() });
      toastSuccess(`Offer set to ${OFFER_STATUS_LABELS[newStatus]}`);
      onDone(updated);
    } catch (failure) {
      setError(failure?.message || "Override failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      size="sm"
      title="TPO OVERRIDE"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">CANCEL</button>
          <button type="button" onClick={submit} disabled={busy} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} OVERRIDE
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <p className="border-2 border-black bg-yellow-100 p-2 font-bold">
          Overrides skip the placement policy. {offer.student?.name}&apos;s offer from {offer.companyName} is currently <b>{OFFER_STATUS_LABELS[offer.status]}</b>.
        </p>
        <Field label="New status">
          <select value={newStatus} onChange={(event) => setNewStatus(event.target.value)} className="input-stark w-full text-base sm:text-xs">
            {OFFER_STATUSES.filter((status) => status !== offer.status).map((status) => (
              <option key={status} value={status}>{OFFER_STATUS_LABELS[status]}</option>
            ))}
          </select>
        </Field>
        <Field label="Reason *" hint="Recorded in the offer history and shown to the student.">
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={500} className="input-stark w-full text-base sm:text-xs" />
        </Field>
        {error && <p role="alert" className="font-bold text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

function HistoryDialog({ offer, onClose }) {
  return (
    <Modal open title={`${offer.student?.name ?? "Offer"} — ${offer.companyName}`} onClose={onClose}>
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div><b className="block text-[9px] uppercase text-gray-500">Role</b>{offer.roleTitle}</div>
          <div><b className="block text-[9px] uppercase text-gray-500">Package</b>{formatLpa(offer.packageLpa)}</div>
          <div><b className="block text-[9px] uppercase text-gray-500">Respond by</b>{formatDateTime(offer.expiresAt)}</div>
          <div><b className="block text-[9px] uppercase text-gray-500">Joining</b>{formatDate(offer.joiningDate)}</div>
          <div><b className="block text-[9px] uppercase text-gray-500">Created by</b>{offer.createdBy?.name || "—"} ({offer.createdByRole || "—"})</div>
          <div><b className="block text-[9px] uppercase text-gray-500">Academic year</b>{offer.academicYear}</div>
        </div>
        {offer.responseReason && <p className="border-l-4 border-black bg-gray-50 p-2">Student&apos;s reason: {offer.responseReason}</p>}
        {offer.offerLetterUrl && (
          <a href={offer.offerLetterUrl} target="_blank" rel="noopener noreferrer" className="font-black uppercase underline">Offer letter</a>
        )}
        <ol className="space-y-1 border-l-2 border-black pl-3">
          {[...(offer.statusHistory ?? [])].reverse().map((entry, index) => (
            <li key={`${entry.changedAt}-${index}`}>
              <b className="uppercase">{OFFER_STATUS_LABELS[entry.status] ?? entry.status}</b>{" "}
              <span className="text-gray-600">{formatDateTime(entry.changedAt)}{entry.byName ? ` · ${entry.byName}` : ""}</span>
              {entry.note && <div>{entry.note}</div>}
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}

/** TPO offer management (`tpo.offers`): GET /offers with counts, create, place, override, revoke. */
export default function OfferManagement() {
  const { params, setParams } = usePanel("tpo.offers");
  const status = OFFER_STATUSES.includes(params.status) ? params.status : "all";
  const [query, setQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const [override, setOverride] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const { data, error, loading, reload, setData } = useAsync(() => listOffers({ status, q: query || undefined, limit: 200 }), [status, query, refreshKey]);
  useSocketEvent("placement:offers", () => setRefreshKey((key) => key + 1));

  const offers = data?.offers ?? [];
  const counts = data?.statusCounts ?? {};
  const historyOffer = params.offerId ? offers.find((offer) => offer._id === params.offerId) : null;

  const replaceOffer = (offer) => {
    if (!offer?._id) return;
    setData((current) => (current ? { ...current, offers: current.offers.map((item) => (item._id === offer._id ? offer : item)) } : current));
    setRefreshKey((key) => key + 1);
  };

  const runConfirm = async (reason) => {
    const { action, offer } = confirm;
    setBusy(true);
    try {
      if (action === "place") {
        replaceOffer(await markOfferPlaced(offer._id));
        toastSuccess(`${offer.student?.name} is officially placed at ${offer.companyName}`);
      } else if (action === "revoke") {
        replaceOffer(await revokeOffer(offer._id, { reason }));
        toastSuccess("Offer revoked");
      }
      setConfirm(null);
    } catch (failure) {
      toastError(failure, "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const showCreate = creating || Boolean(params.create) || Boolean(params.applicationId);
  const closeCreate = () => {
    setCreating(false);
    if (params.create || params.applicationId) setParams({ ...params, create: undefined, applicationId: undefined }, { replace: true });
  };

  const tabs = [
    { id: "all", label: "All", count: sumCounts(counts) },
    ...OFFER_STATUSES.map((value) => ({ id: value, label: OFFER_STATUS_LABELS[value], count: counts[value] ?? 0 })),
  ];

  return (
    <Panel
      title="Offer management"
      icon={Handshake}
      badge={`${data?.total ?? 0} OFFERS`}
      actions={
        <>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh offers" className="btn-secondary px-2 py-1 text-[10px]">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setCreating(true)} className="btn-primary px-2 py-1 text-[10px]">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> NEW OFFER
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KpiTile label="Pending response" value={counts.extended ?? 0} accent="bg-blue-50" />
          <KpiTile label="Accepted" value={counts.accepted ?? 0} hint="Ready to mark placed" accent="bg-green-50" />
          <KpiTile label="Placed" value={counts.placed ?? 0} />
          <KpiTile label="Declined / expired" value={(counts.rejected ?? 0) + (counts.expired ?? 0)} accent="bg-red-50" />
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <Tabs tabs={tabs} value={status} onChange={(id) => setParams({ status: id === "all" ? undefined : id })} label="Offer status" />
          <SearchBox value={query} onSearch={setQuery} placeholder="Student, company, role" className="lg:w-72" />
        </div>

        {loading && !data ? (
          <LoadingState label="LOADING OFFERS…" />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : offers.length === 0 ? (
          <EmptyState icon={Handshake} title="No offers" text={status === "all" ? "Extend an offer from the applicants list or with NEW OFFER." : "No offers in this status."} />
        ) : (
          <DataTable head={["Student", "Company / role", "Package", "Status", "Respond by", "Actions"]}>
            {offers.map((offer) => (
              <tr key={offer._id} className={params.offerId === offer._id ? "bg-yellow-50" : "hover:bg-gray-50"}>
                <Td>
                  <div className="font-black uppercase">{offer.student?.name}</div>
                  <div className="text-[10px] font-semibold text-gray-600">
                    {offer.student?.rollNumber || offer.student?.email} · {offer.student?.branch || "—"} · CGPA {offer.student?.cgpa ?? "—"}
                  </div>
                </Td>
                <Td>
                  <div className="font-bold">{offer.companyName}</div>
                  <div className="text-[10px] text-gray-600">{offer.roleTitle}</div>
                </Td>
                <Td className="whitespace-nowrap">
                  <div className="font-black tabular-nums">{formatLpa(offer.packageLpa)}</div>
                  {offer.offerType && offer.offerType !== "normal" && <ColorBadge color={TYPE_COLORS[offer.offerType]}>{offer.offerType}</ColorBadge>}
                </Td>
                <Td>
                  <StatusBadge kind="offer" status={offer.status}>{OFFER_STATUS_LABELS[offer.status]?.toUpperCase()}</StatusBadge>
                  {offer.tpoOverride && <div className="mt-0.5 text-[9px] font-black uppercase text-purple-800">TPO override</div>}
                </Td>
                <Td className="whitespace-nowrap tabular-nums">{offer.status === "extended" ? formatDate(offer.expiresAt) : "—"}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {offer.status === "accepted" && (
                      <button type="button" onClick={() => setConfirm({ action: "place", offer })} className="btn-primary px-1.5 py-1 text-[10px]">
                        <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> PLACE
                      </button>
                    )}
                    {(offer.status === "extended" || offer.status === "accepted") && (
                      <button type="button" onClick={() => setConfirm({ action: "revoke", offer })} className="btn-secondary px-1.5 py-1 text-[10px] text-red-700">
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> REVOKE
                      </button>
                    )}
                    <button type="button" onClick={() => setOverride(offer)} className="btn-secondary px-1.5 py-1 text-[10px]">
                      <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> OVERRIDE
                    </button>
                    <button type="button" onClick={() => setParams({ offerId: offer._id })} aria-label="Offer history" className="btn-secondary px-1.5 py-1">
                      <History className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
        {data && data.total > offers.length && (
          <p className="text-[10px] font-semibold text-gray-600">Showing {offers.length} of {data.total}. Narrow the search to see the rest.</p>
        )}
      </div>

      {historyOffer && <HistoryDialog offer={historyOffer} onClose={() => setParams({ ...params, offerId: undefined }, { replace: true })} />}
      {override && (
        <OverrideDialog
          key={override._id}
          offer={override}
          onClose={() => setOverride(null)}
          onDone={(offer) => {
            setOverride(null);
            replaceOffer(offer);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.action === "place" ? "CONFIRM PLACEMENT?" : "REVOKE OFFER?"}
        body={
          confirm?.action === "place"
            ? `${confirm.offer.student?.name} accepted ${confirm.offer.companyName} (${formatLpa(confirm.offer.packageLpa)}). Mark them officially placed?`
            : confirm
              ? `The offer from ${confirm.offer.companyName} is withdrawn and the application marked not selected. The student is notified.`
              : ""
        }
        confirmLabel={confirm?.action === "place" ? "MARK PLACED" : "REVOKE"}
        danger={confirm?.action === "revoke"}
        requireReason={confirm?.action === "revoke"}
        reasonLabel="Reason (3–500 characters)"
        busy={busy}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
      <OfferForm
        open={showCreate}
        allowPicker
        applicationId={params.applicationId}
        onClose={closeCreate}
        onCreated={(offer) => {
          closeCreate();
          setRefreshKey((key) => key + 1);
          if (offer?._id) setParams({ offerId: offer._id });
        }}
      />
    </Panel>
  );
}
