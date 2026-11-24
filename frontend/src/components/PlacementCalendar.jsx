import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { formatTime } from "../ui/format.js";
import { useNow } from "../ui/useNow.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const EVENT_KINDS = Object.freeze({
  drive: { label: "Drive", className: "bg-green-200" },
  deadline: { label: "Deadline", className: "bg-red-100" },
  round: { label: "Round", className: "bg-yellow-200" },
  training: { label: "Training", className: "bg-blue-100" },
  offer: { label: "Offer expiry", className: "bg-orange-100" },
  class: { label: "Class", className: "bg-purple-100" },
});

const pad = (value) => String(value).padStart(2, "0");
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const monthKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

const parseDate = (value) => {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hasTime = (value) => typeof value === "string" && /T\d{2}:\d{2}/.test(value) && !/T00:00(:00(\.000)?)?Z?$/.test(value);

/** Legacy drive items (driveDate|eventDate|date|deadline + companyName/roleTitle) → events. */
const fromDrive = (drive, index) => {
  const raw = drive.driveDate || drive.eventDate || drive.date || drive.deadline;
  const date = parseDate(raw);
  if (!date) return null;
  const company = drive.companyName || drive.company?.name || (typeof drive.company === "string" ? drive.company : null) || "Company";
  return {
    id: String(drive._id ?? drive.id ?? `drive-${index}`),
    date,
    time: hasTime(raw) ? formatTime(raw) : null,
    title: company,
    subtitle: drive.roleTitle || drive.title || "Placement drive",
    kind: drive.driveDate || drive.eventDate || drive.date ? "drive" : "deadline",
    location: drive.location || null,
  };
};

const fromEvent = (event, index) => {
  const date = parseDate(event?.date);
  if (!date) return null;
  return {
    id: String(event.id ?? `event-${index}`),
    date,
    time: hasTime(event.date) ? formatTime(event.date) : null,
    title: event.title || "Event",
    subtitle: event.subtitle || null,
    kind: EVENT_KINDS[event.kind] ? event.kind : "drive",
    location: event.location || null,
  };
};

/**
 * Month calendar of placement events (stable API, also used by tpo's TpoCalendarPanel).
 * Props: { drives = [], events?: [{ id, date, title, subtitle?, kind?, location? }], title, compact, initialDate? }
 * The visible month follows the data (first upcoming item) until the user navigates.
 */
export default function PlacementCalendar({ drives = [], events, title = "PLACEMENT CALENDAR", compact = false, initialDate }) {
  const now = useNow(60000);
  const today = useMemo(() => new Date(now), [now]);
  const todayKey = dayKey(today);

  const items = useMemo(() => {
    const list = [
      ...(Array.isArray(events) ? events.map(fromEvent) : []),
      ...(Array.isArray(drives) ? drives.map(fromDrive) : []),
    ].filter(Boolean);
    return list
      .map((item) => ({ ...item, day: dayKey(item.date) }))
      .sort((a, b) => a.date - b.date || a.title.localeCompare(b.title));
  }, [drives, events]);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      if (!map.has(item.day)) map.set(item.day, []);
      map.get(item.day).push(item);
    }
    return map;
  }, [items]);

  const initial = parseDate(initialDate);
  const initialKey = initial ? dayKey(initial) : null;
  const upcoming = items.filter((item) => item.day >= todayKey);
  const anchor = initial ?? upcoming[0]?.date ?? items.at(-1)?.date ?? today;

  // User navigation wins; a new initialDate resets it ("adjust state while rendering").
  const [nav, setNav] = useState({ for: initialKey, month: null, selected: initialKey });
  let view = nav;
  if (nav.for !== initialKey) {
    view = { for: initialKey, month: null, selected: initialKey };
    setNav(view);
  }
  const visible = view.month ? parseDate(`${view.month}-01`) : new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const selectedKey = view.selected;

  const year = visible.getFullYear();
  const month = visible.getMonth();
  const monthLabel = visible.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday + daysInMonth }, (_, index) => (index < firstWeekday ? null : index - firstWeekday + 1));
  const monthCount = items.filter((item) => item.date.getFullYear() === year && item.date.getMonth() === month).length;

  const changeMonth = (offset) =>
    setNav((current) => ({ ...current, month: monthKey(new Date(year, month + offset, 1)), selected: null }));
  const goToday = () => setNav((current) => ({ ...current, month: monthKey(today), selected: todayKey }));
  const select = (key) => setNav((current) => ({ ...current, month: monthKey(visible), selected: current.selected === key ? null : key }));

  const selectedItems = selectedKey ? byDay.get(selectedKey) ?? [] : [];
  const agenda = selectedKey ? selectedItems : upcoming.slice(0, compact ? 5 : 8);
  const selectedLabel = selectedKey ? parseDate(selectedKey).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : null;

  return (
    <section className={`card-stark min-w-0 bg-white ${compact ? "p-3" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-black pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h3 className="truncate text-sm font-black uppercase">{title}</h3>
        </div>
        <span className="badge-stark bg-yellow-100 text-[10px] tabular-nums">{items.length} EVENTS</span>
      </div>

      <div className={`mt-4 grid min-w-0 gap-4 ${compact ? "" : "xl:grid-cols-[minmax(0,1fr)_16rem]"}`}>
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" onClick={() => changeMonth(-1)} aria-label="Previous month" className="btn-secondary min-h-11 min-w-11 justify-center p-1.5 sm:min-h-0 sm:min-w-0">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="text-center">
              <div className="text-xs font-black uppercase">{monthLabel}</div>
              <div className="text-[10px] font-bold text-gray-500 tabular-nums">{monthCount} this month</div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={goToday} className="btn-secondary min-h-11 px-2 py-1 text-[10px] sm:min-h-0">
                TODAY
              </button>
              <button type="button" onClick={() => changeMonth(1)} aria-label="Next month" className="btn-secondary min-h-11 min-w-11 justify-center p-1.5 sm:min-h-0 sm:min-w-0">
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 border-l border-t border-black" role="grid" aria-label={monthLabel}>
            {WEEKDAYS.map((day) => (
              <div key={day} role="columnheader" className="border-b border-r border-black bg-black py-1 text-center text-[9px] font-black uppercase text-white sm:text-[10px]">
                {day}
              </div>
            ))}
            {cells.map((day, index) => {
              if (!day) return <div key={`blank-${index}`} className={`${compact ? "min-h-10" : "min-h-12 sm:min-h-16"} border-b border-r border-black bg-gray-50`} />;
              const key = `${year}-${pad(month + 1)}-${pad(day)}`;
              const dayItems = byDay.get(key) ?? [];
              const isToday = key === todayKey;
              const isSelected = key === selectedKey;
              const kinds = [...new Set(dayItems.map((item) => item.kind))].slice(0, 3);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => select(key)}
                  aria-pressed={isSelected}
                  aria-label={`${day} ${monthLabel}${dayItems.length ? `, ${dayItems.length} event${dayItems.length === 1 ? "" : "s"}` : ""}`}
                  title={dayItems.map((item) => `${EVENT_KINDS[item.kind]?.label}: ${item.title}${item.subtitle ? ` – ${item.subtitle}` : ""}`).join("\n") || undefined}
                  className={`relative ${compact ? "min-h-10" : "min-h-12 sm:min-h-16"} border-b border-r border-black p-1 text-left transition-colors ${
                    isSelected ? "bg-black text-white" : dayItems.length ? "bg-yellow-50 hover:bg-yellow-100" : "bg-white hover:bg-gray-50"
                  } ${isToday && !isSelected ? "ring-2 ring-inset ring-black" : ""}`}
                >
                  <span className="text-[11px] font-black tabular-nums">{day}</span>
                  {kinds.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-0.5">
                      {kinds.map((kind) => (
                        <span key={kind} className={`h-2 w-2 border border-black ${EVENT_KINDS[kind]?.className ?? "bg-gray-200"}`} />
                      ))}
                    </span>
                  )}
                  {dayItems.length > 1 && <span className="absolute bottom-0.5 right-1 text-[9px] font-black tabular-nums">{dayItems.length}</span>}
                </button>
              );
            })}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1" aria-label="Legend">
            {Object.entries(EVENT_KINDS)
              .filter(([kind]) => items.some((item) => item.kind === kind))
              .map(([kind, meta]) => (
                <li key={kind} className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-gray-600">
                  <span className={`h-2.5 w-2.5 border border-black ${meta.className}`} aria-hidden="true" />
                  {meta.label}
                </li>
              ))}
          </ul>
        </div>

        <aside className="min-w-0 border-2 border-black bg-gray-50 p-3" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-black uppercase text-gray-700">{selectedLabel ?? "Coming up"}</div>
            {selectedKey && (
              <button type="button" onClick={() => setNav((current) => ({ ...current, month: monthKey(visible), selected: null }))} className="text-[10px] font-black uppercase underline">
                Show upcoming
              </button>
            )}
          </div>
          {agenda.length ? (
            <ul className="mt-2 space-y-2">
              {agenda.map((item) => (
                <li key={`${item.kind}:${item.id}:${item.day}`} className="border border-black bg-white p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`badge-stark text-[9px] ${EVENT_KINDS[item.kind]?.className ?? "bg-gray-100"}`}>{(EVENT_KINDS[item.kind]?.label ?? item.kind).toUpperCase()}</span>
                    {!selectedKey && (
                      <span className="text-[10px] font-bold text-gray-600 tabular-nums">
                        {item.date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                      </span>
                    )}
                    {item.time && <span className="text-[10px] font-bold text-gray-600 tabular-nums">{item.time}</span>}
                  </div>
                  <div className="mt-1 break-words text-xs font-black uppercase">{item.title}</div>
                  {item.subtitle && <div className="break-words text-[10px] font-bold text-gray-600">{item.subtitle}</div>}
                  {item.location && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] font-semibold">
                      <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.location}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[11px] font-medium leading-relaxed text-gray-600">
              {selectedKey ? "Nothing scheduled on this day." : "No upcoming events. Tap a marked date to see past ones."}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
