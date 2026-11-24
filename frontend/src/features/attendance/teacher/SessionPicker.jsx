import { ChevronRight, History } from "lucide-react";
import { listSessions } from "../../../lib/api/attendance.js";
import EmptyState from "../../../ui/EmptyState.jsx";
import ErrorState from "../../../ui/ErrorState.jsx";
import LoadingState from "../../../ui/LoadingState.jsx";
import StatusBadge from "../../../ui/StatusBadge.jsx";
import { useAsync } from "../../../ui/useAsync.js";
import { useNow } from "../../../ui/useNow.js";
import { addDays, groupByIstDay, istDayKey, sessionStatus } from "./ist.js";
import { SessionMeta } from "./parts.jsx";

/**
 * Day-grouped list of sessions to pick from (newest first).
 * Defaults: ended classes of the last 60 days.
 */
export default function SessionPicker({ courseId, status = "ended", days = 60, aheadDays = 0, onPick, emptyTitle = "No past classes yet", emptyText }) {
  const today = istDayKey(useNow(60000));
  const now = useNow(60000);
  const from = addDays(today, -days);
  const to = addDays(today, aheadDays);
  const state = useAsync(() => listSessions({ from, to, courseId, status, limit: 500 }), [from, to, courseId, status]);

  if (state.loading && !state.data) return <LoadingState label="LOADING CLASSES…" />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  const sessions = [...(state.data ?? [])].reverse();
  if (!sessions.length) return <EmptyState icon={History} title={emptyTitle} text={emptyText ?? "Reports appear here after a class ends."} />;

  return (
    <div className="space-y-3">
      {groupByIstDay(sessions).map((group) => (
        <section key={group.key}>
          <h4 className="mb-1 border-b-2 border-black pb-0.5 text-xs font-black uppercase">{group.label}</h4>
          <ul className="space-y-1.5">
            {group.sessions.map((session) => {
              const stats = session.stats || {};
              const attended = (stats.present ?? 0) + (stats.late ?? 0);
              return (
                <li key={session._id}>
                  <button
                    type="button"
                    onClick={() => onPick(session)}
                    className="flex min-h-11 w-full items-center justify-between gap-2 border-2 border-black bg-white p-2 text-left hover:bg-gray-50"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-black">{session.course?.code}</span>
                        <span className="truncate text-xs font-bold">{session.course?.name}</span>
                        <StatusBadge kind="session" status={sessionStatus(session, now)} />
                      </span>
                      <SessionMeta session={session} />
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs font-black tabular-nums">
                      {session.status !== "scheduled" && session.status !== "cancelled" && `${attended}/${stats.enrolled ?? 0}`}
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
