import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { WifiOff } from "lucide-react";
import AuthScreen from "./components/AuthScreen.jsx";
import Chat from "./components/Chat.jsx";
import HeaderBar from "./components/HeaderBar.jsx";
import SidebarDrawer from "./components/SidebarDrawer.jsx";
import ChangePasswordModal from "./features/auth/ChangePasswordModal.jsx";
import RequireAuth from "./features/auth/RequireAuth.jsx";
import { logout, refreshCurrentUser, userUpdated } from "./features/auth/session.js";
import NotificationsBridge from "./features/notifications/NotificationsBridge.jsx";
import { markRead } from "./features/notifications/thunks.js";
import { openAIConversation, startNewAIChat } from "./services/aiRequestHandler.js";
import { selectChatSessions } from "./store/aiChatSlice.js";
import ErrorBoundary from "./ui/ErrorBoundary.jsx";
import LoadingState from "./ui/LoadingState.jsx";
import FeatureSlot from "./workspace/FeatureSlot.jsx";
import MobilePaneSwitcher from "./workspace/MobilePaneSwitcher.jsx";
import OverlayHost from "./workspace/OverlayHost.jsx";
import WorkspaceView from "./workspace/WorkspaceView.jsx";
import { parsePanelUrl, stripPanelParams } from "./workspace/deepLink.js";
import { isFullHeightResumeTool } from "./workspace/panels.js";
import { applyUiActions, openPanel, switchMode } from "./workspace/uiActions.js";

const ResetPasswordPage = lazy(() => import("./features/auth/ResetPasswordPage.jsx"));
const ReportIssuePage = lazy(() => import("./features/help/ReportIssuePage.jsx"));

function FullPageLoader({ label = "LOADING…" }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#f8fafc]">
      <LoadingState label={label} />
    </div>
  );
}

/** Applies `/?panel=…&params=…&nid=…` once after sign-in, then removes only those keys (UI-ACTIONS.md §9). */
function useDeepLinkOnce() {
  const dispatch = useDispatch();
  const location = useLocation();
  const navigate = useNavigate();
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    const link = parsePanelUrl(location.search);
    if (link) {
      applyUiActions([{ panel: link.panel, params: link.params }], { source: "deeplink" });
      if (link.nid) dispatch(markRead(link.nid));
      navigate({ pathname: location.pathname, search: stripPanelParams(location.search), hash: location.hash }, { replace: true });
      return;
    }
    // Gmail OAuth returns to "/?gmail_connected=1": PR outreach consumes that parameter.
    const query = new URLSearchParams(location.search);
    if (query.has("gmail_connected") || query.has("gmail_error")) {
      applyUiActions([{ panel: "pr-outreach" }], { source: "deeplink" });
    }
  }, [dispatch, location, navigate]);
}

/** The signed-in app: header, chat | workspace, overlays, drawer (FRONTEND.md §10). */
function AuthenticatedShell() {
  const dispatch = useDispatch();
  const user = useSelector((state) => state.appContext.user);
  const activeMode = useSelector((state) => state.appContext.activeMode);
  const activePanel = useSelector((state) => state.appContext.activePanel);
  const activeResumeTool = useSelector((state) => state.appContext.activeResumeTool);
  const pane = useSelector((state) => state.appContext.mobilePane);
  const offline = useSelector((state) => state.session.offline);
  const chatSessions = useSelector(selectChatSessions);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useDeepLinkOnce();

  const fullHeight = activeMode === "resume" && isFullHeightResumeTool(activeResumeTool);
  const forcedPasswordChange = Boolean(user?.mustChangePassword);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f8fafc] text-black">
      <HeaderBar activeMode={activeMode} setActiveMode={switchMode} user={user} onOpenDrawer={() => setDrawerOpen(true)} />

      {offline && (
        <div role="status" className="flex shrink-0 items-center justify-center gap-2 border-b-2 border-black bg-yellow-100 px-3 py-1.5 text-[11px] font-bold">
          <WifiOff className="h-3.5 w-3.5" aria-hidden="true" /> The server can&apos;t be reached — showing your saved data.
        </div>
      )}

      <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-3 py-3 sm:px-4 sm:py-4">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6">
          <section aria-label="Copilot chat" className={`${pane === "chat" ? "flex" : "hidden"} min-h-0 flex-col lg:col-span-4 lg:flex`}>
            <Chat />
          </section>
          <section
            aria-label="Workspace"
            className={`${pane === "workspace" ? "block" : "hidden"} min-h-0 lg:col-span-8 lg:block ${fullHeight ? "overflow-hidden" : "overflow-y-auto overscroll-contain pr-1"}`}
          >
            <ErrorBoundary resetKey={activePanel}>
              <Suspense fallback={<LoadingState label="LOADING WORKSPACE…" />}>
                <WorkspaceView />
              </Suspense>
            </ErrorBoundary>
          </section>
        </div>
      </main>

      <MobilePaneSwitcher />
      <OverlayHost onChangePassword={() => setPasswordOpen(true)} />
      <SidebarDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        user={user}
        onLogout={() => dispatch(logout())}
        chatSessions={chatSessions}
        onSelectChat={(sessionId) => dispatch(openAIConversation(sessionId))}
        onNewChat={() => dispatch(startNewAIChat(user?.name))}
        onOpenPanel={openPanel}
        onChangePassword={() => setPasswordOpen(true)}
      />
      <NotificationsBridge />
      {(forcedPasswordChange || passwordOpen) && (
        <ChangePasswordModal
          user={user}
          forced={forcedPasswordChange}
          onClose={() => setPasswordOpen(false)}
          onSignOut={() => dispatch(logout())}
          onChanged={(updated) => {
            setPasswordOpen(false);
            if (updated) dispatch(userUpdated(updated));
            else dispatch(refreshCurrentUser()).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

/** "/" — session gate (FRONTEND.md §5). */
function AppShell() {
  const status = useSelector((state) => state.session.status);
  const endedReason = useSelector((state) => state.session.endedReason);

  if (status === "checking") return <FullPageLoader label="CHECKING YOUR SESSION…" />;
  if (status !== "authenticated") {
    return <AuthScreen notice={endedReason === "expired" ? "Your session expired. Please sign in again." : undefined} />;
  }
  return <AuthenticatedShell />;
}

/** Standalone pages owned by other roles, loaded through the feature registry. */
function RoutePage({ children }) {
  return <div className="min-h-dvh bg-[#f8fafc] text-black">{children}</div>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />} />
      <Route
        path="/attend"
        element={
          <RequireAuth
            roles={["student"]}
            title="SIGN IN TO MARK ATTENDANCE"
            subtitle="Stay signed in on this phone so the next scan takes one second."
          >
            <RoutePage>
              <FeatureSlot name="AttendPage" resetKey="route:attend" standalone fallbackLabel="OPENING ATTENDANCE…" />
            </RoutePage>
          </RequireAuth>
        }
      />
      <Route
        path="/present/:sessionId"
        element={
          <RequireAuth roles={["teacher", "tpo", "admin"]} title="SIGN IN TO PRESENT ATTENDANCE" subtitle="Use your faculty account to show the live QR code.">
            <RoutePage>
              <FeatureSlot name="PresenterPage" resetKey="route:present" standalone fallbackLabel="OPENING PRESENTER…" />
            </RoutePage>
          </RequireAuth>
        }
      />
      <Route
        path="/reset-password/:token"
        element={
          <Suspense fallback={<FullPageLoader />}>
            <ResetPasswordPage />
          </Suspense>
        }
      />
      <Route
        path="/report-issue"
        element={
          <Suspense fallback={<FullPageLoader />}>
            <ReportIssuePage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
