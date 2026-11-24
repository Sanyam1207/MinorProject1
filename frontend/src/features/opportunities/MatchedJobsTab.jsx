import { useMemo, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Sparkles } from "lucide-react";
import DriveGrid from "../../components/DriveGrid.jsx";
import { runAIFeature } from "../../services/aiRequestHandler.js";
import { selectLatestJobs } from "../../store/aiChatSlice.js";
import { EmptyState, Tabs } from "../../ui/index.js";
import { openPanel } from "../../workspace/index.js";
import JobActions from "./JobActions.jsx";
import { toJobVM } from "./jobVM.js";

const FILTERS = [
  { id: "all", label: "ALL" },
  { id: "campus", label: "CAMPUS" },
  { id: "external", label: "OPEN MARKET" },
];

/** AI MATCHES: the copilot's latest job search (aiChat.latestJobs, JOB-FEED.md §12.5). */
export default function MatchedJobsTab() {
  const dispatch = useDispatch();
  const latestJobs = useSelector(selectLatestJobs);
  const [filter, setFilter] = useState("all");
  // Local updates (applied / saved) keyed by job id; the Redux list stays as the copilot sent it.
  const [patches, setPatches] = useState({});

  const jobs = useMemo(
    () =>
      (Array.isArray(latestJobs) ? latestJobs : [])
        .map((item) => toJobVM(item, "ai"))
        .filter((job) => job.id || job.roleTitle !== "Role"),
    [latestJobs],
  );
  const merged = jobs.map((job) => (patches[job.id] ? { ...job, ...patches[job.id] } : job));
  const visible = filter === "all" ? merged : merged.filter((job) => job.kind === filter);
  const counts = { all: merged.length, campus: merged.filter((job) => job.kind === "campus").length };
  counts.external = merged.length - counts.campus;

  const findMatches = () => dispatch(runAIFeature("drives"));

  if (!merged.length) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No AI matches yet"
        text="Ask the copilot to find jobs for you — it searches campus drives and the open market and ranks them against your profile."
        action={
          <button type="button" onClick={findMatches} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            FIND MATCHES WITH AI
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs label="Match filter" tabs={FILTERS.map((tab) => ({ ...tab, count: counts[tab.id] }))} value={filter} onChange={setFilter} className="w-auto" />
        <button type="button" onClick={findMatches} className="btn-secondary min-h-11 px-3 py-1.5 text-[11px] sm:min-h-0">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          REFRESH MATCHES
        </button>
      </div>
      <DriveGrid
        jobs={visible}
        onOpen={(job) => openPanel("jobs.detail", { jobId: job.id, source: job.source, from: "matched" })}
        renderActions={(job) => (
          <JobActions
            job={job}
            from="matched"
            onChange={(patch) => setPatches((previous) => ({ ...previous, [job.id]: { ...(previous[job.id] || {}), ...patch } }))}
          />
        )}
        empty={<EmptyState title="Nothing in this filter" text="Switch to ALL to see every match." />}
      />
    </div>
  );
}
