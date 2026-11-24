import { useSelector } from "react-redux";
import { BriefcaseBusiness } from "lucide-react";
import { selectLatestJobs } from "../../store/aiChatSlice.js";
import { selectActiveJobsTab } from "../../store/appContextSlice.js";
import { ErrorBoundary, Tabs } from "../../ui/index.js";
import { openPanel } from "../../workspace/index.js";
import CampusJobsTab from "./CampusJobsTab.jsx";
import JobDetail from "./JobDetail.jsx";
import MarketJobsTab from "./MarketJobsTab.jsx";
import MatchedJobsTab from "./MatchedJobsTab.jsx";
import TrackerTab from "./TrackerTab.jsx";

const TABS = [
  { id: "matched", label: "AI MATCHES", panel: "jobs.matched" },
  { id: "campus", label: "CAMPUS", panel: "jobs.campus" },
  { id: "market", label: "OPEN MARKET", panel: "jobs.market" },
  { id: "tracker", label: "SAVED", panel: "jobs.tracker" },
];

const SUBTITLES = {
  matched: "Jobs the copilot found for you across campus drives and the open market.",
  campus: "Placement drives at your college, with your eligibility checked by the placement office rules.",
  market: "Open-market jobs collected from public sources. Applying opens the company's page.",
  tracker: "Your saved open-market jobs, from saved to offer.",
  detail: "Everything about this role in one place.",
};

const CONTENT = { matched: MatchedJobsTab, campus: CampusJobsTab, market: MarketJobsTab, tracker: TrackerTab, detail: JobDetail };

/**
 * JobsHub — StudentMode `drives` (panels jobs.matched | jobs.campus | jobs.market | jobs.tracker | jobs.detail).
 * No props: the tab comes from appContext.activeJobsTab, params from usePanel(<panel id>) in each tab.
 */
export default function JobsHub() {
  const activeTab = useSelector(selectActiveJobsTab);
  const latestJobs = useSelector(selectLatestJobs);
  const tab = CONTENT[activeTab] ? activeTab : "matched";
  const Content = CONTENT[tab];
  const tabs = TABS.map((entry) => (entry.id === "matched" ? { ...entry, count: Array.isArray(latestJobs) ? latestJobs.length : 0 } : entry));

  return (
    <section className="card-stark min-w-0 bg-white">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b-2 border-black pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <BriefcaseBusiness className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-black uppercase">Jobs &amp; drives</h3>
            <p className="text-[11px] font-medium text-gray-600">{SUBTITLES[tab]}</p>
          </div>
        </div>
      </div>
      <Tabs
        label="Job lists"
        tabs={tabs}
        value={tab === "detail" ? null : tab}
        onChange={(id) => openPanel(TABS.find((entry) => entry.id === id)?.panel ?? "jobs.matched")}
        className="mb-4"
      />
      <ErrorBoundary resetKey={tab}>
        <Content />
      </ErrorBoundary>
    </section>
  );
}
