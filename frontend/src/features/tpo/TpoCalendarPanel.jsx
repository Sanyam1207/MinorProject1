import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { listDrives, listPrograms } from "../../lib/api/admin.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { ErrorState, LoadingState, Panel, formatDate, formatTime, useAsync, useNow } from "../../ui/index.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import { toDateInput } from "./mappers.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const KIND_STYLE = {
  deadline: { label: "Deadline", color: "bg-red-100" },
  drive: { label: "Drive", color: "bg-green-200" },
  round: { label: "Round", color: "bg-yellow-100" },
  training: { label: "Training", color: "bg-blue-100" },
};

const buildEvents = (drives, programs) => {
  const events = [];
  for (const drive of drives) {
    if (["rejected"].includes(drive.status)) continue;
    const base = { driveId: drive._id, title: `${drive.companyName} — ${drive.title}`, status: drive.status };
    if (drive.applicationDeadline) events.push({ ...base, id: `${drive._id}:deadline`, kind: "deadline", at: drive.applicationDeadline });
    if (drive.driveDate) events.push({ ...base, id: `${drive._id}:drive`, kind: "drive", at: drive.driveDate, allDay: true });
    (drive.rounds || []).forEach((round, index) => {
      if (round.at) events.push({ ...base, id: `${drive._id}:round${index}`, kind: "round", at: round.at, detail: round.name });
    });
  }
  for (const program of programs) {
    if (program.status === "cancelled") continue;
    (program.schedule || []).forEach((session, index) => {
      if (session.date) {
        events.push({
          id: `${program._id}:s${index}`,
          programId: program._id,
          kind: "training",
          at: session.date,
          allDay: !session.time,
          time: session.time,
          title: program.title,
          detail: session.topic || session.venue,
        });
      }
    });
  }
  return events
    .filter((event) => !Number.isNaN(new Date(event.at).getTime()))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
};

const monthCells = (year, month) => {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday first
  const days = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    return day >= 1 && day <= days ? new Date(year, month, day) : null;
  });
};

function EventRow({ event }) {
  const style = KIND_STYLE[event.kind];
  const open = () => (event.driveId ? openPanel("tpo.drives", { jobId: event.driveId }) : openPanel("tpo.training", { programId: event.programId }));
  return (
    <li>
      <button type="button" onClick={open} className="flex w-full items-start gap-2 border border-black bg-white p-2 text-left hover:bg-gray-50">
        <span className={`badge-stark shrink-0 text-[9px] uppercase ${style.color}`}>{style.label}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-black uppercase">{event.title}</span>
          <span className="block text-[10px] font-semibold text-gray-600">
            {formatDate(event.at)}
            {event.time ? ` · ${event.time}` : event.allDay ? "" : ` · ${formatTime(event.at)}`}
            {event.detail ? ` · ${event.detail}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Drive calendar for the TPO (`tpo.calendar`): deadlines, drive dates, rounds and training sessions. */
export default function TpoCalendarPanel() {
  const { params, setParams } = usePanel("tpo.calendar");
  const now = useNow(60000);
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading, reload } = useAsync(async () => {
    const [drives, programs] = await Promise.all([listDrives({ status: "all" }), listPrograms({ status: "all" }).catch(() => [])]);
    return { drives: drives.items, programs };
  }, [refreshKey]);
  useSocketEvent("placement:job", () => setRefreshKey((key) => key + 1));

  const events = useMemo(() => buildEvents(data?.drives ?? [], data?.programs ?? []), [data]);
  const todayKey = toDateInput(new Date(now));
  const selectedKey = params.date ? (/^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : toDateInput(params.date) || todayKey) : todayKey;
  const [monthAnchor, setMonthAnchor] = useState(null);
  const [anchorFor, setAnchorFor] = useState(params.date);
  if (anchorFor !== params.date) {
    // A new date from the copilot / a deep link moves the visible month to it.
    setAnchorFor(params.date);
    setMonthAnchor(null);
  }
  const anchor = monthAnchor ?? selectedKey.slice(0, 7);
  const [year, month] = anchor.split("-").map(Number);
  const cells = monthCells(year, month - 1);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const event of events) {
      const key = toDateInput(event.at);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    }
    return map;
  }, [events]);

  const shiftMonth = (delta) => {
    const date = new Date(year, month - 1 + delta, 1);
    setMonthAnchor(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  };
  const dayEvents = byDay.get(selectedKey) ?? [];
  const upcoming = events.filter((event) => toDateInput(event.at) >= todayKey).slice(0, 12);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  return (
    <Panel
      title="Drive calendar"
      icon={CalendarDays}
      badge={`${events.length} EVENTS`}
      actions={
        <button type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh calendar" className="btn-secondary px-2 py-1 text-[10px]">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      }
    >
      {loading && !data ? (
        <LoadingState label="LOADING CALENDAR…" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month" className="btn-secondary p-1.5">
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <div className="text-sm font-black uppercase">{monthLabel}</div>
              <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month" className="btn-secondary p-1.5">
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-7 border-l-2 border-t-2 border-black text-center">
              {WEEKDAYS.map((day) => (
                <div key={day} className="border-b-2 border-r-2 border-black bg-black py-1 text-[9px] font-black uppercase text-white">{day}</div>
              ))}
              {cells.map((date, index) => {
                if (!date) return <div key={`empty-${index}`} className="min-h-12 border-b-2 border-r-2 border-black bg-gray-50" />;
                const key = toDateInput(date);
                const list = byDay.get(key) ?? [];
                const kinds = [...new Set(list.map((event) => event.kind))];
                const isSelected = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setParams({ date: key })}
                    aria-pressed={isSelected}
                    aria-label={`${formatDate(date)}: ${list.length} events`}
                    className={`min-h-12 border-b-2 border-r-2 border-black p-1 text-left align-top ${isSelected ? "bg-black text-white" : key === todayKey ? "bg-yellow-100" : "bg-white hover:bg-gray-100"}`}
                  >
                    <span className="block text-[11px] font-black tabular-nums">{date.getDate()}</span>
                    <span className="mt-0.5 flex flex-wrap gap-0.5">
                      {kinds.map((kind) => <span key={kind} className={`h-2 w-2 border border-black ${KIND_STYLE[kind].color}`} />)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold uppercase">
              {Object.entries(KIND_STYLE).map(([kind, style]) => (
                <span key={kind} className="flex items-center gap-1"><span className={`h-2.5 w-2.5 border border-black ${style.color}`} /> {style.label}</span>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <section>
              <h4 className="mb-2 text-xs font-black uppercase">{formatDate(selectedKey)}</h4>
              {dayEvents.length === 0 ? (
                <p className="border-2 border-dashed border-gray-400 bg-gray-50 p-3 text-[11px] font-semibold text-gray-600">Nothing scheduled on this day.</p>
              ) : (
                <ul className="space-y-1">{dayEvents.map((event) => <EventRow key={event.id} event={event} />)}</ul>
              )}
            </section>
            <section>
              <h4 className="mb-2 text-xs font-black uppercase">Coming up</h4>
              {upcoming.length === 0 ? (
                <p className="text-[11px] font-semibold text-gray-600">No upcoming deadlines, drives or sessions.</p>
              ) : (
                <ul className="space-y-1">{upcoming.map((event) => <EventRow key={event.id} event={event} />)}</ul>
              )}
            </section>
          </div>
        </div>
      )}
    </Panel>
  );
}
