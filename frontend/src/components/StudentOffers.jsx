import { useEffect, useState } from "react";
import { ArrowUpCircle, CheckCircle2, ExternalLink, Gift, ShieldAlert, Undo2, XCircle } from "lucide-react";
import { invalidateOpportunitySummary } from "../features/opportunities/summary.js";
import {
  acceptOffer,
  getOfferPolicy,
  listMyOffers,
  rejectOffer,
  withdrawOfferAcceptance,
} from "../lib/api/placements.js";
import { useSocketEvent } from "../lib/realtime.js";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  StatusBadge,
  toastError,
  toastInfo,
  toastSuccess,
  useAsync,
  useNow,
} from "../ui/index.js";
import { formatDate, formatDateTime, formatLpa, formatRelative } from "../ui/format.js";
import { usePanel } from "../workspace/index.js";

const OFFER_LABELS = {
  extended: "Pending response",
  accepted: "Accepted",
  rejected: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
  placed: "Placed",
};
const TYPE_BADGE = {
  normal: { label: "NORMAL", className: "bg-gray-100" },
  dream: { label: "DREAM", className: "bg-purple-100" },
  "super-dream": { label: "SUPER DREAM", className: "bg-yellow-200" },
};

const lpa = (value) => (value === null || value === undefined ? "—" : formatLpa(value));

function History({ entries }) {
  if (!entries.length) return null;
  return (
    <ol className="space-y-1 border-l-2 border-black pl-3">
      {entries.map((entry, index) => (
        <li key={`${entry.status}-${entry.changedAt ?? index}`} className="text-[11px]">
          <span className="font-black uppercase">{OFFER_LABELS[entry.status] ?? entry.status ?? "Update"}</span>
          <span className="ml-2 font-bold text-gray-500">{formatDateTime(entry.changedAt)}</span>
          {entry.note && <div className="font-medium text-gray-700">{entry.note}</div>}
        </li>
      ))}
    </ol>
  );
}

function OfferCard({ offer, policy, highlighted, onAction }) {
  const now = useNow(60000);
  const [showHistory, setShowHistory] = useState(false);
  const type = TYPE_BADGE[offer.offerType] ?? TYPE_BADGE.normal;
  const pending = offer.status === "extended";
  const holding = offer.currentAcceptedPackage !== null && offer.currentAcceptedPackage !== undefined;
  const upgrade = pending && holding && offer.isDreamEligible;
  const enforced = policy?.enforceOneOffer !== false;
  const blocked = pending && holding && !offer.isDreamEligible && enforced && !offer.tpoOverride;
  const expiresMs = offer.expiresAt ? new Date(offer.expiresAt).getTime() : null;
  const expired = pending && expiresMs !== null && expiresMs <= now;
  const letter = typeof offer.offerLetterUrl === "string" && /^https?:\/\//i.test(offer.offerLetterUrl) ? offer.offerLetterUrl : null;

  return (
    <article
      id={`offer-${offer._id}`}
      className={`card-stark flex min-w-0 flex-col gap-3 bg-white ${highlighted ? "outline outline-4 outline-yellow-300" : ""}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-extrabold uppercase text-gray-600">{offer.companyName}</div>
          <h4 className="break-words text-sm font-black uppercase leading-tight">{offer.roleTitle}</h4>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`badge-stark text-[10px] ${type.className}`}>{type.label}</span>
          <StatusBadge kind="offer" status={offer.status}>
            {(offer.statusLabel || OFFER_LABELS[offer.status] || offer.status).toUpperCase()}
          </StatusBadge>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <div className="text-[9px] font-extrabold uppercase text-gray-500">Package</div>
          <div className="text-lg font-black tabular-nums">{lpa(offer.packageLpa)}</div>
        </div>
        {holding && pending && (
          <div className="text-[11px] font-bold text-gray-700">
            {lpa(offer.packageLpa)} vs current {lpa(offer.currentAcceptedPackage)}
            {offer.dreamMultiplier ? <span className="text-gray-500"> (upgrade needs ≥ {offer.dreamMultiplier}× current)</span> : null}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold uppercase text-gray-600">
        {offer.location && <span>{offer.location}</span>}
        {offer.joiningDate && <span>Joining {formatDate(offer.joiningDate)}</span>}
        {offer.academicYear && <span>AY {offer.academicYear}</span>}
        {pending && offer.expiresAt && (
          <span className={expired ? "text-red-700" : "text-orange-700"}>
            {expired ? "Expired" : "Respond by"} {formatDateTime(offer.expiresAt)} ({formatRelative(offer.expiresAt, now)})
          </span>
        )}
      </div>

      {upgrade && (
        <p className="flex items-start gap-1.5 border-2 border-black bg-purple-100 p-2 text-[11px] font-bold">
          <ArrowUpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This is a dream upgrade: accepting it releases your current offer.
        </p>
      )}
      {blocked && (
        <p className="flex items-start gap-1.5 border-2 border-black bg-yellow-100 p-2 text-[11px] font-bold">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          One-offer policy: you already hold an offer and this one is not a dream upgrade, so it cannot be accepted. You can decline it.
        </p>
      )}

      {offer.statusHistory.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
            className="text-[10px] font-black uppercase underline underline-offset-2"
          >
            {showHistory ? "Hide history" : `Show history (${offer.statusHistory.length})`}
          </button>
          {showHistory && (
            <div className="mt-2">
              <History entries={offer.statusHistory} />
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t-[1.5px] border-black pt-3">
        {letter && (
          <a href={letter} target="_blank" rel="noopener noreferrer" className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] sm:min-h-0">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            OFFER LETTER
          </a>
        )}
        {pending && !expired && (
          <>
            <button
              type="button"
              onClick={() => onAction("accept", offer)}
              disabled={blocked}
              title={blocked ? "Blocked by the one-offer policy" : undefined}
              className="btn-primary min-h-11 px-2.5 py-1.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
            >
              {upgrade ? <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
              {upgrade ? "UPGRADE & ACCEPT" : "ACCEPT"}
            </button>
            <button
              type="button"
              onClick={() => onAction("reject", offer)}
              className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] text-red-700 sm:min-h-0"
            >
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              DECLINE
            </button>
          </>
        )}
        {offer.status === "accepted" && (
          <button
            type="button"
            onClick={() => onAction("withdraw", offer)}
            className="btn-secondary min-h-11 px-2.5 py-1.5 text-[11px] text-red-700 sm:min-h-0"
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            WITHDRAW ACCEPTANCE
          </button>
        )}
      </div>
    </article>
  );
}

const DIALOGS = {
  accept: { title: "ACCEPT THIS OFFER?", confirm: "ACCEPT", danger: false, reason: false },
  reject: { title: "DECLINE THIS OFFER?", confirm: "DECLINE", danger: true, reason: true },
  withdraw: { title: "WITHDRAW YOUR ACCEPTANCE?", confirm: "WITHDRAW", danger: true, reason: true },
};

/** StudentOffers — StudentMode `offers` (usePanel("offers") {offerId, status}). */
export default function StudentOffers() {
  const { params } = usePanel("offers");
  const offers = useAsync(() => listMyOffers(), []);
  const policy = useAsync(() => getOfferPolicy().catch(() => null), []);
  useSocketEvent("placement:offer", () => offers.reload());
  const [pendingAction, setPendingAction] = useState(null);
  const [busy, setBusy] = useState(false);

  const highlightId = params.offerId ?? null;
  const list = offers.data ?? [];
  const visible = params.status ? list.filter((offer) => offer.status === params.status || offer._id === highlightId) : list;
  const hasHighlight = Boolean(highlightId) && list.some((offer) => offer._id === highlightId);
  useEffect(() => {
    if (!hasHighlight) return;
    document.getElementById(`offer-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasHighlight, highlightId]);

  const run = async (reason) => {
    if (!pendingAction) return;
    const { type, offer } = pendingAction;
    setBusy(true);
    try {
      if (type === "accept") {
        const { released } = await acceptOffer(offer._id);
        toastSuccess(`Offer from ${offer.companyName} accepted`);
        if (released.length) toastInfo(`Released: ${released.map((entry) => entry.companyName).filter(Boolean).join(", ")}`);
      } else if (type === "reject") {
        await rejectOffer(offer._id, reason);
        toastSuccess("Offer declined");
      } else {
        await withdrawOfferAcceptance(offer._id, reason);
        toastSuccess("Acceptance withdrawn");
      }
      invalidateOpportunitySummary();
      setPendingAction(null);
      offers.reload();
    } catch (error) {
      toastError(error, "Could not update the offer");
    } finally {
      setBusy(false);
    }
  };

  const activePolicy = policy.data;
  const dialog = pendingAction ? DIALOGS[pendingAction.type] : null;
  const pendingCount = list.filter((offer) => offer.status === "extended").length;

  return (
    <Panel title="My offers" icon={Gift} badge={pendingCount ? `${pendingCount} PENDING` : undefined}>
      {activePolicy && activePolicy.enforceOneOffer !== false && (
        <div className="mb-4 border-2 border-black bg-blue-100 p-3 text-[11px] font-semibold leading-relaxed">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-black uppercase">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            One-offer policy {activePolicy.academicYear ? `· ${activePolicy.academicYear}` : ""}
          </div>
          You can hold one accepted offer.
          {activePolicy.allowDreamUpgrade
            ? ` A new offer of at least ${activePolicy.dreamMultiplier ?? 1.5}× your current package counts as a dream upgrade and replaces it.`
            : " Upgrades to a higher offer are not allowed this year."}
          {Number.isFinite(Number(activePolicy.offerExpiryDays)) && ` Offers expire ${activePolicy.offerExpiryDays} days after they are extended.`}
        </div>
      )}

      {offers.error && !offers.data ? (
        <ErrorState error={offers.error} title="COULD NOT LOAD YOUR OFFERS" onRetry={offers.reload} />
      ) : !offers.data ? (
        <LoadingState label="LOADING OFFERS…" />
      ) : visible.length === 0 ? (
        <EmptyState icon={Gift} title="No offers yet" text="Offers from campus drives appear here. You will get a notification when one arrives." />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map((offer) => (
            <OfferCard
              key={offer._id}
              offer={offer}
              policy={activePolicy}
              highlighted={offer._id === highlightId}
              onAction={(type, target) => setPendingAction({ type, offer: target })}
            />
          ))}
        </div>
      )}

      {dialog && (
        <ConfirmDialog
          open
          title={dialog.title}
          body={
            pendingAction.type === "accept"
              ? `${pendingAction.offer.roleTitle} at ${pendingAction.offer.companyName} · ${lpa(pendingAction.offer.packageLpa)}.${
                  pendingAction.offer.currentAcceptedPackage !== null && pendingAction.offer.isDreamEligible
                    ? " Your current accepted offer will be released."
                    : ""
                } Accepting may block other applications under the placement policy.`
              : pendingAction.type === "reject"
                ? `Decline the offer from ${pendingAction.offer.companyName}? This cannot be undone.`
                : `Withdraw your acceptance of ${pendingAction.offer.companyName}? The placement office is notified.`
          }
          confirmLabel={dialog.confirm}
          danger={dialog.danger}
          busy={busy}
          requireReason={dialog.reason}
          reasonLabel="Reason (shared with the placement office)"
          onConfirm={run}
          onCancel={() => (busy ? null : setPendingAction(null))}
        />
      )}
    </Panel>
  );
}
