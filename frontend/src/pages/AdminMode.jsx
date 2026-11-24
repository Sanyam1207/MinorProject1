import { useDispatch, useSelector } from "react-redux";
import {
  BarChart3,
  Briefcase,
  Building2,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  FilePlus2,
  Flag,
  GraduationCap,
  Handshake,
  LoaderCircle,
  Plus,
  Presentation,
  Rss,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRoundCheck,
} from "lucide-react";
import { runAIFeature, sendAIMessage, startNewAIChat } from "../services/aiRequestHandler.js";
import { selectAILoading, selectJobCreationWorkspace } from "../store/aiChatSlice.js";
import EmptyState from "../ui/EmptyState.jsx";
import BackBar from "../workspace/BackBar.jsx";
import FeatureSlot from "../workspace/FeatureSlot.jsx";
import ToolTile from "../workspace/ToolTile.jsx";
import { panelTitle } from "../workspace/panels.js";
import { openPanel } from "../workspace/uiActions.js";

const JOB_FIELD_LABELS = {
  company_name: "Company",
  job_role: "Role",
  job_description: "Description",
  app_deadline: "Application deadline",
  salary: "Salary",
  eligible_branches: "Eligible branches",
  location: "Location",
  employment_type: "Employment type",
  minimum_cgpa: "Minimum CGPA",
  maximum_backlogs: "Maximum backlogs",
  graduation_years: "Graduation years",
  skills: "Skills",
  selection_process: "Selection process",
};

const formatJobValue = (value) => {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not specified";
  if (value === null || value === undefined || value === "") return "Not specified";
  return String(value);
};

/** Inline AI job creator (tpo.job-creator): the chat fills the draft, these buttons confirm/post. */
function JobCreatorPanel({ user }) {
  const dispatch = useDispatch();
  const workspace = useSelector(selectJobCreationWorkspace);
  const aiLoading = useSelector(selectAILoading);
  const job = workspace.job || {};
  const hasDraft = Boolean(workspace.job);

  const sendJobAction = (text) =>
    dispatch(sendAIMessage({ text, modeName: "job-creation", source: "job-creator-ui", feature: "job-creation" }));

  // A new chat session = a new draft (the backend keys drafts by session), so job 2 never overwrites job 1.
  const startNewJob = () => {
    dispatch(startNewAIChat(user?.name));
    dispatch(runAIFeature("job-creation"));
  };

  return (
    <section className="card-stark bg-white">
      <div className="mb-4 flex flex-col justify-between gap-3 border-b-2 border-black pb-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <div className="bg-black p-2 text-white">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase">AI job creator</h3>
            <p className="text-[11px] font-semibold text-gray-600">Build, validate and post a placement job through chat.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge-stark text-[10px] ${workspace.status === "post" ? "bg-green-200" : workspace.status === "error" ? "bg-red-100" : "bg-yellow-100"}`}>
            {String(workspace.status || "idle").replaceAll("_", " ").toUpperCase()}
          </span>
          {hasDraft && (
            <button type="button" disabled={aiLoading} onClick={startNewJob} className="btn-secondary px-2.5 py-1 text-[10px] disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> NEW JOB
            </button>
          )}
        </div>
      </div>

      {workspace.status === "error" && workspace.error && (
        <div role="alert" className="mb-3 border-2 border-black bg-red-100 p-3 text-xs font-bold">
          {workspace.error}
        </div>
      )}

      {!hasDraft ? (
        <EmptyState
          icon={Briefcase}
          title="Create a placement job"
          text="The assistant collects the company, role, description, deadline and eligibility details."
          action={
            <button type="button" disabled={aiLoading} onClick={() => dispatch(runAIFeature("job-creation"))} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
              {aiLoading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />} START JOB CREATOR
            </button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {Object.entries(JOB_FIELD_LABELS).map(([field, label]) => (
              <div key={field} className={`${field === "job_description" ? "sm:col-span-2" : ""} border-2 border-black bg-gray-50 p-2.5`}>
                <div className="text-[9px] font-black uppercase text-gray-500">{label}</div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] font-bold">{formatJobValue(job[field])}</div>
              </div>
            ))}
          </div>

          {workspace.missingFields.length > 0 && (
            <div className="mt-3 border-2 border-black bg-yellow-100 p-3">
              <div className="text-[10px] font-black uppercase">Still required</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {workspace.missingFields.map((field) => (
                  <span key={field} className="badge-stark bg-white text-[9px]">
                    {JOB_FIELD_LABELS[field] || field}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[10px] font-semibold">Provide these details in the chat.</p>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t-2 border-black pt-3">
            <div className="text-[10px] font-bold text-gray-600">
              {workspace.status === "post" ? `Saved job ID: ${workspace.persistedJobId || "created"}` : "Every change made in chat updates this draft."}
            </div>
            {workspace.status === "ready" && !workspace.awaitingConfirmation && (
              <button type="button" disabled={aiLoading} onClick={() => sendJobAction("Post the job")} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
                <Send className="h-4 w-4" aria-hidden="true" /> REVIEW FOR POSTING
              </button>
            )}
            {workspace.awaitingConfirmation && (
              <button
                type="button"
                disabled={aiLoading}
                onClick={() => sendJobAction("Yes, confirm and post the job")}
                className="btn-primary min-h-11 bg-green-200 px-3 py-1.5 text-xs text-black hover:bg-green-300 disabled:opacity-50 sm:min-h-0"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> CONFIRM & POST
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// activeFeature → feature component (tpo / attendance-teacher roles) + props.
const FEATURE_SLOTS = {
  "gap-analysis": { name: "GapAnalysisPanel" },
  "job-postings": { name: "DrivesPanel", props: { scope: "tpo" } },
  "application-review": { name: "ApplicantsPanel", props: { scope: "tpo" } },
  "offer-management": { name: "OfferManagement" },
  "policy-configuration": { name: "PolicyConfigPanel" },
  "placement-analytics": { name: "PlacementAnalyticsPanel" },
  "training-scheduler": { name: "TrainingScheduler" },
  "placement-calendar": { name: "TpoCalendarPanel" },
  "job-feed": { name: "JobFeedAdminPanel" },
  faculty: { name: "FacultyPanel" },
  recruiters: { name: "RecruitersPanel" },
  "attendance-oversight": { name: "AttendanceOversightPanel" },
  "issue-reports": { name: "IssueReportsPanel" },
};

function TpoHome() {
  const dispatch = useDispatch();
  const hasDraft = useSelector((state) => Boolean(state.aiChat.jobCreationWorkspace.job));
  const gapStatus = useSelector((state) => state.aiChat.gapAnalysisWorkspace.status);

  const tiles = [
    {
      icon: FilePlus2,
      title: "AI job creator",
      description: "Create, validate and publish placement jobs through the AI assistant.",
      badge: hasDraft ? "DRAFT IN PROGRESS" : "AI ASSISTED",
      badgeClass: "bg-green-200",
      onClick: () => (hasDraft ? openPanel("tpo.job-creator") : dispatch(runAIFeature("job-creation"))),
    },
    {
      icon: TrendingUp,
      title: "Gap analysis",
      description: "Curriculum-to-industry skill gaps with AI elective recommendations.",
      badge: "AI ASSISTED",
      badgeClass: "bg-green-200",
      onClick: () => (gapStatus === "idle" ? dispatch(runAIFeature("gap-analysis")) : openPanel("tpo.gap-analysis")),
    },
    { icon: Briefcase, title: "Placement drives", description: "Create, edit, approve and close campus drives.", badge: "DRIVES", badgeClass: "bg-blue-100", panel: "tpo.drives" },
    { icon: UserRoundCheck, title: "Applicants", description: "Review applicants and move them through hiring stages.", badge: "PIPELINE", badgeClass: "bg-blue-100", panel: "tpo.applicants" },
    { icon: Handshake, title: "Offer management", description: "Track offer lifecycles, placements and TPO overrides.", badge: "OFFERS", badgeClass: "bg-yellow-100", panel: "tpo.offers" },
    { icon: Settings, title: "Placement policy", description: "One-offer rule, dream upgrades and offer expiry.", badge: "RULES", badgeClass: "bg-gray-100", panel: "tpo.policy" },
    { icon: BarChart3, title: "Placement analytics", description: "Placed %, offers, CTC and branch-wise outcomes.", badge: "STATS", badgeClass: "bg-purple-100", panel: "tpo.analytics" },
    { icon: GraduationCap, title: "Training scheduler", description: "Create training programs, schedules and rosters.", badge: "PROGRAMS", badgeClass: "bg-green-100", panel: "tpo.training" },
    { icon: CalendarDays, title: "Drive calendar", description: "Drive dates and application deadlines by day.", badge: "CALENDAR", badgeClass: "bg-yellow-100", panel: "tpo.calendar" },
    { icon: Rss, title: "Job feed", description: "Open-market job sync status, sources and the live feed.", badge: "MARKET", badgeClass: "bg-blue-100", panel: "tpo.job-feed" },
    { icon: Presentation, title: "Faculty", description: "Invite teachers and manage faculty accounts.", badge: "ACCOUNTS", badgeClass: "bg-gray-100", panel: "tpo.faculty" },
    { icon: Building2, title: "Recruiters", description: "Invite recruiters and manage company accounts.", badge: "ACCOUNTS", badgeClass: "bg-gray-100", panel: "tpo.recruiters" },
    { icon: CalendarCheck, title: "Attendance oversight", description: "Course and session attendance across departments.", badge: "READ-ONLY", badgeClass: "bg-blue-100", panel: "tpo.attendance" },
    { icon: Flag, title: "Issue reports", description: "Problems reported by students, faculty and visitors.", badge: "INBOX", badgeClass: "bg-red-100", panel: "tpo.issues" },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tiles.map(({ panel, onClick, title, ...tile }) => (
        <ToolTile key={title} {...tile} title={title.toUpperCase()} onClick={onClick ?? (() => openPanel(panel))} />
      ))}
    </div>
  );
}

/** College TPO workspace (FRONTEND.md §12.2) — also the admin workspace. */
export default function AdminMode({ user }) {
  const activeFeature = useSelector((state) => state.appContext.activeFeature);
  const activePanel = useSelector((state) => state.appContext.activePanel);
  const slot = FEATURE_SLOTS[activeFeature];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="card-stark bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
            <div>
              <h2 className="text-lg font-black uppercase">College TPO mode</h2>
              <p className="text-xs font-semibold text-gray-600">{user?.collegeName || "Drives, applicants, offers, policy, analytics and faculty."}</p>
            </div>
          </div>
          <span className="badge-stark bg-black text-xs text-white">{user?.role === "admin" ? "ADMIN" : "PLACEMENT CELL"}</span>
        </div>
      </div>

      {activeFeature === null || activeFeature === undefined ? (
        <TpoHome />
      ) : (
        <div className="space-y-4">
          <BackBar label="TPO HOME" title={panelTitle(activePanel)} onBack={() => openPanel("tpo.home")} />
          {activeFeature === "job-creator" ? (
            <JobCreatorPanel user={user} />
          ) : slot ? (
            <FeatureSlot name={slot.name} resetKey={activeFeature} {...(slot.props || {})} />
          ) : (
            <EmptyState title="This tool isn't available" text="Go back to TPO home and pick another tool." />
          )}
        </div>
      )}
    </div>
  );
}
