import { lazy, Suspense } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  Award,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  ExternalLink,
  FolderKanban,
  Globe,
  GraduationCap,
  Mic2,
  Package,
  ScanQrCode,
  Sliders,
  Sparkles,
  User,
  Users,
} from "lucide-react";
import { runAIFeature } from "../services/aiRequestHandler.js";
import EmptyState from "../ui/EmptyState.jsx";
import ErrorBoundary from "../ui/ErrorBoundary.jsx";
import LoadingState from "../ui/LoadingState.jsx";
import Tabs from "../ui/Tabs.jsx";
import { formatDate, formatTime } from "../ui/format.js";
import { STATUS_COLORS } from "../ui/statusColors.js";
import BackBar from "../workspace/BackBar.jsx";
import FeatureSlot from "../workspace/FeatureSlot.jsx";
import ToolTile from "../workspace/ToolTile.jsx";
import { useAttendanceSummary, useOpportunitySummary } from "../workspace/featureModules.js";
import { panelTitle } from "../workspace/panels.js";
import { openPanel } from "../workspace/uiActions.js";
import { usePanel } from "../workspace/usePanel.js";

const InterviewWorkspace = lazy(() => import("../components/InterviewWorkspace.jsx"));
const LearningRecommendationWorkspace = lazy(() => import("../components/LearningRecommendationWorkspace.jsx"));

const NOT_SET = "Not set";
const hasValue = (value) => value !== null && value !== undefined && value !== "";

// activeFeature → feature component owned by another role (FeatureSlot registry).
const FEATURE_SLOTS = {
  drives: "JobsHub",
  applications: "ApplicationsPanel",
  offers: "StudentOffers",
  training: "TrainingHub",
  calendar: "CalendarPanel",
  attendance: "StudentAttendancePanel",
  "attendance-scan": "ScanPanel",
  schedule: "StudentSchedulePanel",
};

function StudentHome() {
  const dispatch = useDispatch();
  const interviewStatus = useSelector((state) => state.aiChat.interviewWorkspace.status);
  const attendance = useAttendanceSummary();
  const opportunities = useOpportunitySummary();
  const count = (value, label) => (opportunities.loading ? "…" : `${Number(value) || 0} ${label}`);

  const attendanceBadge =
    attendance.loading
      ? "…"
      : attendance.overallPercent === null || attendance.overallPercent === undefined
        ? "NO CLASSES YET"
        : `${Math.round(attendance.overallPercent)}%`;
  const nextClassBadge = attendance.loading
    ? "…"
    : attendance.nextClass?.startsAt
      ? `NEXT ${formatDate(attendance.nextClass.startsAt, { weekday: "short" })} ${formatTime(attendance.nextClass.startsAt)}`.toUpperCase()
      : "NO UPCOMING CLASS";

  const tiles = [
    { icon: ScanQrCode, title: "Scan attendance QR", description: "Scan the QR your teacher shows to mark yourself present.", badge: "MARK PRESENT", badgeClass: "bg-yellow-200", onClick: () => openPanel("attendance.scan") },
    { icon: CalendarCheck, title: "My attendance", description: "Course-wise attendance, history and how many classes you can miss.", badge: attendanceBadge, badgeClass: STATUS_COLORS.standing[attendance.status] ?? "bg-gray-100", onClick: () => openPanel("attendance.student") },
    { icon: CalendarClock, title: "Class schedule", description: "Upcoming classes, live sessions and cancellations.", badge: nextClassBadge, badgeClass: "bg-blue-100", onClick: () => openPanel("schedule") },
    { icon: Building2, title: "Campus drives", description: "Placement drives at your college with eligibility checks.", badge: count(opportunities.campusCount, "OPEN"), badgeClass: "bg-green-100", onClick: () => openPanel("jobs.campus") },
    { icon: Sparkles, title: "AI job matches", description: "Jobs matched to your profile by the AI job finder.", badge: count(opportunities.aiMatches, "MATCHES"), badgeClass: "bg-purple-100", onClick: () => openPanel("jobs.matched") },
    { icon: Globe, title: "Open market jobs", description: "Live internships and jobs aggregated from across the web.", badge: "LIVE FEED", badgeClass: "bg-blue-100", onClick: () => openPanel("jobs.market") },
    { icon: ClipboardList, title: "My applications", description: "Track every application and its hiring stage.", badge: count(opportunities.applicationsActive, "ACTIVE"), badgeClass: "bg-green-100", onClick: () => openPanel("applications") },
    { icon: Package, title: "My offers", description: "Accept, reject or upgrade placement offers.", badge: count(opportunities.offersPending, "PENDING"), badgeClass: "bg-yellow-100", onClick: () => openPanel("offers") },
    { icon: BookOpen, title: "Training", description: "Aptitude, soft-skill and technical training programs.", badge: count(opportunities.trainingUpcoming, "UPCOMING"), badgeClass: "bg-blue-100", onClick: () => openPanel("training") },
    { icon: CalendarDays, title: "Placement calendar", description: "Drive dates, deadlines and training sessions by day.", badge: "DRIVES & DEADLINES", badgeClass: "bg-yellow-100", onClick: () => openPanel("calendar") },
    { icon: User, title: "My portfolio", description: "Skills, projects, certifications and experience in one place.", badge: "PROFILE", badgeClass: "bg-purple-100", onClick: () => openPanel("portfolio") },
    {
      icon: Mic2,
      title: "Mock interview",
      description: "Practise a job-specific or profile-based interview with AI feedback.",
      badge: "AI INTERVIEWER",
      badgeClass: "bg-yellow-200",
      onClick: () => (interviewStatus === "idle" || interviewStatus === "error" ? dispatch(runAIFeature("mock-interview")) : openPanel("interview")),
    },
    { icon: GraduationCap, title: "Learning roadmap", description: "Study plans built from your mock interview results.", badge: "AI RECOMMENDER", badgeClass: "bg-purple-100", onClick: () => openPanel("learning") },
    { icon: Users, title: "Alumni connect", description: "Find alumni mentors and manage your requests.", badge: "MENTORS", badgeClass: "bg-purple-100", onClick: () => openPanel("alumni") },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tiles.map((tile) => (
        <ToolTile key={tile.title} {...tile} title={tile.title.toUpperCase()} />
      ))}
    </div>
  );
}

const PORTFOLIO_TABS = [
  { id: "profile", label: "Skills & profile" },
  { id: "projects", label: "Projects" },
  { id: "experience", label: "Experience" },
];
const PROFILE_TAB_FOR = { profile: "Skills", projects: "Projects", experience: "Experience" };

function Portfolio({ user }) {
  const { params, setParams } = usePanel("portfolio");
  const tab = PORTFOLIO_TABS.some((item) => item.id === params.tab) ? params.tab : "profile";

  return (
    <section className="card-stark space-y-4 bg-white">
      <div className="flex flex-col items-start justify-between gap-3 border-b-2 border-black pb-3 sm:flex-row sm:items-center">
        <Tabs tabs={PORTFOLIO_TABS} value={tab} onChange={(next) => setParams({ tab: next })} label="Portfolio sections" className="sm:w-auto" />
        <button type="button" onClick={() => openPanel("profile", { tab: PROFILE_TAB_FOR[tab] })} className="btn-primary min-h-11 shrink-0 px-3 py-1.5 text-xs sm:min-h-0">
          <Sliders className="h-3.5 w-3.5" aria-hidden="true" /> EDIT PORTFOLIO
        </button>
      </div>

      {tab === "profile" && (
        <div className="animate-fadeIn space-y-4">
          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
            {[
              ["Full name", user?.name],
              ["College", user?.collegeName],
              ["Passing year", user?.passingYear],
              ["Branch", user?.branch],
              ["CGPA", hasValue(user?.cgpa) ? user.cgpa : null],
              ["Roll number", user?.rollNumber],
            ].map(([label, value]) => (
              <div key={label} className="border-[1.5px] border-black bg-gray-50 p-3">
                <div className="text-[10px] font-extrabold uppercase text-gray-500">{label}</div>
                <div className="break-words text-sm font-black">{hasValue(value) ? value : NOT_SET}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1 text-xs font-extrabold uppercase">
              <User className="h-4 w-4" aria-hidden="true" /> Technical skills
            </div>
            {user?.skills?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {user.skills.map((skill) => (
                  <span key={skill} className="badge-stark bg-gray-100 px-2 py-1 text-xs">
                    {skill}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs italic text-gray-500">No skills added yet.</p>
            )}
          </div>
          <div className="border-t-[1.5px] border-black pt-4">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-black uppercase">
              <Award className="h-4 w-4" aria-hidden="true" /> Certifications
            </h4>
            {user?.certifications?.length ? (
              <div className="space-y-2">
                {user.certifications.map((certificate, index) => (
                  <div key={certificate._id || index} className="flex flex-wrap items-center justify-between gap-2 border border-black bg-gray-50 p-2.5 text-xs">
                    <span className="font-bold">{certificate.name || certificate.title}</span>
                    <span className="flex items-center gap-2 text-[10px] text-gray-500">
                      {certificate.issuer || "Issuer not added"}
                      {certificate.date && <span>· {certificate.date}</span>}
                      {certificate.credentialUrl && (
                        <a href={certificate.credentialUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-black text-black underline">
                          VERIFY <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No certifications yet" text="Add certifications from EDIT PORTFOLIO." className="p-5" />
            )}
          </div>
        </div>
      )}

      {tab === "projects" && (
        <div className="animate-fadeIn space-y-3">
          <h4 className="flex items-center gap-1.5 text-xs font-black uppercase">
            <FolderKanban className="h-4 w-4" aria-hidden="true" /> Projects
          </h4>
          {user?.projects?.length ? (
            user.projects.map((project, index) => (
              <div key={project._id || index} className="border-2 border-black bg-gray-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-black uppercase">{project.title || project.name}</div>
                  {project.link && (
                    <a href={project.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] font-black underline">
                      OPEN <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[12px] font-medium text-gray-600">{project.description || "No description added."}</p>
                {(project.skills || []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-300 pt-3">
                    {project.skills.map((skill) => (
                      <span key={skill} className="badge-stark bg-white text-[10px]">
                        {skill}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          ) : (
            <EmptyState icon={FolderKanban} title="No projects yet" text="Projects you add appear here and power your resume and job matches." />
          )}
        </div>
      )}

      {tab === "experience" && (
        <div className="animate-fadeIn space-y-3">
          <h4 className="flex items-center gap-1.5 text-xs font-black uppercase">
            <BriefcaseBusiness className="h-4 w-4" aria-hidden="true" /> Work history
          </h4>
          {user?.experience?.length ? (
            user.experience.map((item, index) => (
              <div key={item._id || index} className="border-l-4 border-black bg-gray-50 p-3">
                <div className="flex flex-col justify-between gap-1 sm:flex-row">
                  <div>
                    <h5 className="text-xs font-black uppercase">{item.title || "Role"}</h5>
                    <div className="text-[11px] font-bold text-gray-600">{item.company || "Company"}</div>
                  </div>
                  <span className="text-[10px] font-bold text-gray-500">{item.duration || "Duration not added"}</span>
                </div>
                {item.description && <p className="mt-2 whitespace-pre-wrap text-[12px] font-medium text-gray-700">{item.description}</p>}
              </div>
            ))
          ) : (
            <EmptyState icon={BriefcaseBusiness} title="No experience yet" text="Internships, employment and volunteer work will appear here." />
          )}
        </div>
      )}
    </section>
  );
}

function FeatureView({ feature, user }) {
  if (FEATURE_SLOTS[feature]) return <FeatureSlot name={FEATURE_SLOTS[feature]} resetKey={feature} />;
  if (feature === "portfolio") return <Portfolio user={user} />;
  if (feature === "mock-interview" || feature === "learning-recommendation") {
    return (
      <ErrorBoundary resetKey={feature}>
        <Suspense fallback={<LoadingState label="LOADING…" />}>
          {feature === "mock-interview" ? <InterviewWorkspace /> : <LearningRecommendationWorkspace />}
        </Suspense>
      </ErrorBoundary>
    );
  }
  return (
    <EmptyState
      title="This tool isn't available"
      text="Go back to Student home and pick another tool."
      action={
        <button type="button" onClick={() => openPanel("student.home")} className="btn-primary px-3 py-1.5 text-xs">
          STUDENT HOME
        </button>
      }
    />
  );
}

/** Student workspace (FRONTEND.md §12.1): home tiles, or the active feature behind a back bar. */
export default function StudentMode({ user }) {
  const activeFeature = useSelector((state) => state.appContext.activeFeature);
  const activePanel = useSelector((state) => state.appContext.activePanel);
  const cgpa = hasValue(user?.cgpa) ? user.cgpa : NOT_SET;

  return (
    <div className="space-y-6">
      <div className="card-stark flex flex-col items-start justify-between gap-4 bg-white sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h2 className="text-lg font-black uppercase tracking-tight">WELCOME BACK, {user?.name || "STUDENT"}</h2>
          <p className="mt-0.5 break-words text-xs font-medium text-gray-600">
            Branch: <span className="font-bold text-black">{user?.branch || NOT_SET}</span> | CGPA:{" "}
            <span className="font-bold text-black">{cgpa}</span> | Email:{" "}
            <span className="break-all font-mono font-bold text-black">{user?.email || NOT_SET}</span>
          </p>
        </div>
        <button type="button" onClick={() => openPanel("profile")} className="btn-primary min-h-11 shrink-0 px-3 py-1.5 text-xs sm:min-h-0">
          EDIT PROFILE
        </button>
      </div>

      {activeFeature === null || activeFeature === undefined ? (
        <StudentHome />
      ) : (
        <div className="space-y-4">
          <BackBar label="STUDENT HOME" title={panelTitle(activePanel)} onBack={() => openPanel("student.home")} />
          <FeatureView feature={activeFeature} user={user} />
        </div>
      )}
    </div>
  );
}
