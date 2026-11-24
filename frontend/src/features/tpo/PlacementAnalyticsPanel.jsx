import { useState } from "react";
import { BarChart3, Megaphone, RefreshCw } from "lucide-react";
import { getPlacementStats } from "../../lib/api/admin.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { EmptyState, ErrorState, LoadingState, Panel, formatDateTime, formatLpa, formatPercent, useAsync } from "../../ui/index.js";
import { usePanel } from "../../workspace/index.js";
import AnnouncementForm from "./AnnouncementForm.jsx";
import { APPLICATION_STATUS_LABELS, OFFER_STATUS_LABELS, isValidAcademicYear } from "./mappers.js";
import { BarRow, DataTable, KpiTile, Td } from "./parts.jsx";

const APP_ORDER = ["applied", "shortlisted", "interview", "offered", "hired", "rejected", "withdrawn"];
const APP_COLORS = { applied: "bg-blue-200", shortlisted: "bg-purple-200", interview: "bg-yellow-300", offered: "bg-green-300", hired: "bg-green-500", rejected: "bg-red-300", withdrawn: "bg-gray-300" };
const OFFER_ORDER = ["extended", "accepted", "placed", "rejected", "withdrawn", "expired"];
const OFFER_COLORS = { extended: "bg-blue-200", accepted: "bg-green-300", placed: "bg-black", rejected: "bg-red-300", withdrawn: "bg-gray-300", expired: "bg-orange-300" };

const lpa = (value) => (value === null || value === undefined ? "—" : formatLpa(value));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key) => {
  const [year, month] = String(key).split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${String(year).slice(2)}`;
};

/** Monthly offers vs accepted as an inline SVG column chart (no chart library). */
function MonthlyChart({ monthly }) {
  const max = Math.max(1, ...monthly.map((row) => row.offers || 0));
  const width = 600;
  const height = 160;
  const pad = { top: 10, bottom: 28, left: 8, right: 8 };
  const slot = (width - pad.left - pad.right) / Math.max(1, monthly.length);
  const barWidth = Math.max(4, slot * 0.35);
  const scale = (value) => ((value || 0) / max) * (height - pad.top - pad.bottom);
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Offers and accepted offers per month" className="h-auto w-full">
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="#000" strokeWidth="1.5" />
        {monthly.map((row, index) => {
          const x = pad.left + index * slot + slot / 2;
          const offersHeight = scale(row.offers);
          const acceptedHeight = scale(row.accepted);
          return (
            <g key={row.month}>
              <rect x={x - barWidth} y={height - pad.bottom - offersHeight} width={barWidth} height={offersHeight} fill="#bfdbfe" stroke="#000" strokeWidth="1">
                <title>{`${monthLabel(row.month)}: ${row.offers} offers`}</title>
              </rect>
              <rect x={x} y={height - pad.bottom - acceptedHeight} width={barWidth} height={acceptedHeight} fill="#000">
                <title>{`${monthLabel(row.month)}: ${row.accepted} accepted`}</title>
              </rect>
              <text x={x} y={height - pad.bottom + 14} textAnchor="middle" fontSize="10" fontWeight="700">
                {monthLabel(row.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex gap-3 text-[10px] font-bold uppercase">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 border border-black bg-blue-200" /> Offers</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 bg-black" /> Accepted / placed</span>
      </figcaption>
    </figure>
  );
}

function Section({ title, children }) {
  return (
    <section className="border-2 border-black p-3">
      <h4 className="mb-2 text-xs font-black uppercase">{title}</h4>
      {children}
    </section>
  );
}

/** Placement analytics (`tpo.analytics`): GET /placements/stats. */
export default function PlacementAnalyticsPanel() {
  const { params, setParams } = usePanel("tpo.analytics");
  const [draft, setDraft] = useState({ academicYear: params.academicYear ?? "", branch: params.branch ?? "", passingYear: "" });
  const [passingYear, setPassingYear] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [announcing, setAnnouncing] = useState(false);
  const academicYear = params.academicYear && isValidAcademicYear(params.academicYear) ? params.academicYear : undefined;

  const { data: stats, error, loading, reload } = useAsync(
    () => getPlacementStats({ academicYear, branch: params.branch, passingYear: passingYear || undefined }),
    [academicYear, params.branch, passingYear, refreshKey],
  );
  useSocketEvent("placement:offers", () => setRefreshKey((key) => key + 1));

  const apply = (event) => {
    event.preventDefault();
    setParams({ academicYear: draft.academicYear.trim() || undefined, branch: draft.branch.trim() || undefined }, { replace: true });
    setPassingYear(draft.passingYear.trim());
  };

  const totals = stats?.totals ?? {};
  const packages = stats?.packages ?? {};
  const appCounts = stats?.applicationsByStatus ?? {};
  const offerCounts = stats?.offersByStatus ?? {};
  const appMax = Math.max(0, ...APP_ORDER.map((key) => appCounts[key] ?? 0));
  const offerMax = Math.max(0, ...OFFER_ORDER.map((key) => offerCounts[key] ?? 0));
  const branches = stats?.byBranch ?? [];
  const companies = stats?.topCompanies ?? [];
  const monthly = stats?.monthly ?? [];
  const drives = totals.drives ?? {};

  return (
    <Panel
      title="Placement analytics"
      icon={BarChart3}
      badge={stats?.academicYear ? `AY ${stats.academicYear}` : undefined}
      actions={
        <>
          <button type="button" onClick={() => setAnnouncing(true)} className="btn-secondary px-2 py-1 text-[10px]">
            <Megaphone className="h-3.5 w-3.5" aria-hidden="true" /> ANNOUNCE
          </button>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh stats" className="btn-secondary px-2 py-1 text-[10px]">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </>
      }
    >
      <form onSubmit={apply} className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <input value={draft.academicYear} onChange={(e) => setDraft({ ...draft, academicYear: e.target.value })} placeholder="Academic year (2026-27)" aria-label="Academic year" className="input-stark text-base sm:text-xs" />
        <input value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} placeholder="Branch (all)" aria-label="Branch" className="input-stark text-base sm:text-xs" />
        <input value={draft.passingYear} onChange={(e) => setDraft({ ...draft, passingYear: e.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" placeholder="Passing year (all)" aria-label="Passing year" className="input-stark text-base sm:text-xs" />
        <button type="submit" className="btn-primary justify-center px-3 py-1.5 text-xs">APPLY</button>
      </form>
      {params.academicYear && !academicYear && (
        <p className="mb-3 text-[11px] font-bold text-red-700">“{params.academicYear}” is not a valid academic year — showing the current one.</p>
      )}

      {loading && !stats ? (
        <LoadingState label="CRUNCHING NUMBERS…" />
      ) : error && !stats ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !stats ? (
        <EmptyState icon={BarChart3} title="No statistics" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <KpiTile label="Students" value={totals.students ?? 0} hint={`${totals.unplacedStudents ?? 0} not placed yet`} />
            <KpiTile label="Placed" value={formatPercent(totals.placedPercent, 1)} hint={`${totals.placedStudents ?? 0} students`} accent="bg-green-100" />
            <KpiTile label="Offers" value={totals.offers ?? 0} hint={`${totals.applications ?? 0} applications`} accent="bg-blue-50" />
            <KpiTile label="Drives" value={drives.total ?? 0} hint={`${drives.active ?? 0} active · ${drives.pending ?? 0} pending`} accent="bg-yellow-50" />
            <KpiTile label="Median CTC" value={lpa(packages.medianLpa)} hint={`Average ${lpa(packages.avgLpa)}`} />
            <KpiTile label="Highest CTC" value={lpa(packages.maxLpa)} hint={`Lowest ${lpa(packages.minLpa)}`} />
            <KpiTile label="Accepted offers" value={(offerCounts.accepted ?? 0) + (offerCounts.placed ?? 0)} hint={`${offerCounts.extended ?? 0} awaiting response`} />
            <KpiTile label="Packages counted" value={packages.count ?? 0} hint="Best offer per placed student" />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Section title="Applications by stage">
              <div className="space-y-1.5">
                {APP_ORDER.map((status) => (
                  <BarRow key={status} label={APPLICATION_STATUS_LABELS[status]} value={appCounts[status] ?? 0} max={appMax} color={APP_COLORS[status]} />
                ))}
              </div>
            </Section>
            <Section title="Offers by status">
              <div className="space-y-1.5">
                {OFFER_ORDER.map((status) => (
                  <BarRow key={status} label={OFFER_STATUS_LABELS[status]} value={offerCounts[status] ?? 0} max={offerMax} color={OFFER_COLORS[status]} />
                ))}
              </div>
            </Section>
          </div>

          {monthly.length > 0 && (
            <Section title="Offers per month">
              <MonthlyChart monthly={monthly} />
            </Section>
          )}

          <Section title="Branch-wise placement">
            {branches.length === 0 ? (
              <p className="text-[11px] font-semibold text-gray-600">No students in this population.</p>
            ) : (
              <DataTable head={["Branch", "Students", "Placed", "Placed %", "Avg", "Median", "Max"]}>
                {branches.map((row) => (
                  <tr key={row.branch || "unknown"}>
                    <Td className="font-black uppercase">{row.branch || "Not set"}</Td>
                    <Td className="tabular-nums">{row.students}</Td>
                    <Td className="tabular-nums">{row.placedStudents}</Td>
                    <Td className="min-w-32">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 flex-1 border border-black bg-gray-100">
                          <span className="block h-full bg-green-400" style={{ width: `${Math.max(0, Math.min(100, row.placedPercent ?? 0))}%` }} />
                        </span>
                        <span className="w-12 text-right font-bold tabular-nums">{formatPercent(row.placedPercent, 1)}</span>
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{lpa(row.avgLpa)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{lpa(row.medianLpa)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{lpa(row.maxLpa)}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Section>

          <Section title="Top recruiters">
            {companies.length === 0 ? (
              <p className="text-[11px] font-semibold text-gray-600">No offers recorded for this year yet.</p>
            ) : (
              <DataTable head={["Company", "Offers", "Accepted", "Avg CTC", "Max CTC"]}>
                {companies.map((row) => (
                  <tr key={row.companyId || row.companyName}>
                    <Td className="font-black uppercase">{row.companyName}</Td>
                    <Td className="tabular-nums">{row.offers}</Td>
                    <Td className="tabular-nums">{row.accepted}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{lpa(row.avgLpa)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{lpa(row.maxLpa)}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Section>
          <p className="text-[10px] font-semibold text-gray-500">Generated {formatDateTime(stats.generatedAt)}</p>
        </div>
      )}
      <AnnouncementForm open={announcing} onClose={() => setAnnouncing(false)} />
    </Panel>
  );
}
