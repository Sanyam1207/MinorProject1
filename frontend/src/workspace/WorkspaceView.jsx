import { lazy } from "react";
import { useDispatch, useSelector } from "react-redux";
import AccessDeniedView from "../components/AccessDeniedView.jsx";
import WelcomeModeSelect from "../components/WelcomeModeSelect.jsx";
import { runAIFeature } from "../services/aiRequestHandler.js";
import { setActiveResumeTool } from "../store/appContextSlice.js";
import FeatureSlot from "./FeatureSlot.jsx";
import { defaultModeFor, isModeAllowed } from "./modes.js";
import { openPanel, switchMode } from "./uiActions.js";

const StudentMode = lazy(() => import("../pages/StudentMode.jsx"));
const AdminMode = lazy(() => import("../pages/AdminMode.jsx"));
const PROutreach = lazy(() => import("../pages/PROutreach.jsx"));
const AlumniConnect = lazy(() => import("../pages/AlumniConnect.jsx"));

const RESUME_TABS = new Set(["catalog", "editor", "tailor", "ats", "generator", "skill-gap"]);

/**
 * The right-hand column: welcome (mode not chosen) → access guard → the mode
 * page for appContext.activeMode (FRONTEND.md §3). Mode pages owned by other
 * roles are rendered through FeatureSlot (lazy registry + error boundary).
 */
export default function WorkspaceView() {
  const dispatch = useDispatch();
  const user = useSelector((state) => state.appContext.user);
  const role = useSelector((state) => state.appContext.userRole);
  const activeMode = useSelector((state) => state.appContext.activeMode);
  const activeResumeTool = useSelector((state) => state.appContext.activeResumeTool);
  const isModeChosen = useSelector((state) => state.session.isModeChosen);

  if (!isModeChosen) return <WelcomeModeSelect user={user} onModeSelected={switchMode} />;

  if (!isModeAllowed(role, activeMode)) {
    return (
      <AccessDeniedView user={user} attemptedMode={activeMode} onReturnToApprovedMode={() => switchMode(defaultModeFor(role))} />
    );
  }

  switch (activeMode) {
    case "student":
      return <StudentMode user={user} />;
    case "resume":
      return (
        <FeatureSlot
          name="ResumeStudio"
          resetKey="mode:resume"
          user={user}
          // Compatibility props for the pre-rewrite ResumeStudio; the contract component reads usePanel("resume.lab").
          activeTool={activeResumeTool}
          onToolChange={(tool) => {
            if (!tool) openPanel("resume.home");
            else if (RESUME_TABS.has(tool)) openPanel("resume.lab", { tab: tool });
            else if (tool === "ai-keys") openPanel("settings.ai-keys");
            else dispatch(setActiveResumeTool(tool));
          }}
          onRunGenerator={() => dispatch(runAIFeature("resume-generator"))}
        />
      );
    case "pr_outreach":
      return <PROutreach />;
    case "alumni_connect":
    case "alumni":
      return <AlumniConnect user={user} alumniMode={activeMode === "alumni"} />;
    case "teacher":
      return <FeatureSlot name="TeacherMode" resetKey="mode:teacher" user={user} />;
    case "tpo":
      return <AdminMode user={user} />;
    case "company":
      return <FeatureSlot name="CompanyMode" resetKey="mode:company" user={user} />;
    default:
      return (
        <AccessDeniedView user={user} attemptedMode={activeMode} onReturnToApprovedMode={() => switchMode(defaultModeFor(role))} />
      );
  }
}
