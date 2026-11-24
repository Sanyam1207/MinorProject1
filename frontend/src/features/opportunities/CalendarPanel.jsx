import PlacementCalendar from "../../components/PlacementCalendar.jsx";
import { getPlacementCalendar, listCampusJobs, listMyOffers, listMyTraining } from "../../lib/api/placements.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { ErrorState, LoadingState, useAsync } from "../../ui/index.js";
import { formatLpa } from "../../ui/format.js";
import { usePanel } from "../../workspace/index.js";

const LIVE_APPLICATION = new Set(["applied", "shortlisted", "interview", "offered", "hired"]);

/** Drives, rounds of my drives, open deadlines, my training sessions and pending offer expiries. */
async function composeEvents() {
  const [campus, training, offers] = await Promise.allSettled([listCampusJobs({ limit: 100 }), listMyTraining(), listMyOffers()]);
  if ([campus, training, offers].every((result) => result.status === "rejected")) throw campus.reason;
  const events = [];

  if (campus.status === "fulfilled") {
    for (const job of campus.value.items) {
      const applied = LIVE_APPLICATION.has(job.applicationStatus);
      const role = job.roleTitle;
      if (job.driveDate) {
        events.push({ id: `drive:${job.id}`, date: job.driveDate, kind: "drive", title: job.companyName, subtitle: `${role} · drive`, location: job.location });
      }
      if (job.deadline && job.isOpen !== false && !applied && job.isEligible !== false) {
        events.push({ id: `deadline:${job.id}`, date: job.deadline, kind: "deadline", title: job.companyName, subtitle: `Apply by · ${role}` });
      }
      if (applied) {
        for (const round of job.rounds) {
          if (round.at) {
            events.push({
              id: `round:${job.id}:${round.id}`,
              date: round.at,
              kind: "round",
              title: job.companyName,
              subtitle: `${round.name} · ${role}`,
              location: round.venue,
            });
          }
        }
      }
    }
  }

  if (training.status === "fulfilled") {
    for (const enrollment of training.value) {
      const program = enrollment.program;
      if (!program || program.status === "cancelled") continue;
      program.schedule.forEach((session, index) => {
        if (!session.date) return;
        events.push({
          id: `training:${program._id}:${session._id ?? index}`,
          date: session.date,
          kind: "training",
          title: program.title,
          subtitle: [session.time, session.topic].filter(Boolean).join(" · ") || "Training session",
          location: session.venue,
        });
      });
    }
  }

  if (offers.status === "fulfilled") {
    for (const offer of offers.value) {
      if (offer.status !== "extended" || !offer.expiresAt) continue;
      events.push({
        id: `offer:${offer._id}`,
        date: offer.expiresAt,
        kind: "offer",
        title: offer.companyName,
        subtitle: `Offer expires · ${offer.roleTitle} · ${formatLpa(offer.packageLpa)}`,
      });
    }
  }
  return events;
}

async function loadEvents() {
  const server = await getPlacementCalendar().catch(() => null);
  if (Array.isArray(server)) return server;
  return composeEvents();
}

/** CalendarPanel — StudentMode `calendar` (usePanel("calendar") {date}). */
export default function CalendarPanel() {
  const { params } = usePanel("calendar");
  const events = useAsync(loadEvents, []);
  useSocketEvent("placement:application", () => events.reload());
  useSocketEvent("placement:offer", () => events.reload());
  useSocketEvent("placement:training", () => events.reload());

  if (events.error && !events.data) return <ErrorState error={events.error} title="COULD NOT LOAD THE CALENDAR" onRetry={events.reload} />;
  if (!events.data) return <LoadingState label="LOADING CALENDAR…" />;
  return <PlacementCalendar events={events.data} title="Placement calendar" initialDate={params.date} />;
}
