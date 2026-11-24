// Workspace + user context (FRONTEND.md §7.1, UI-ACTIONS.md §6).
//
// Workspace changes arrive ONLY through `panelOpened` (dispatched by
// applyUiActions in src/workspace/uiActions.js); components use openPanel() /
// usePanel() / switchMode() and never dispatch these reducers themselves.
import { createSlice } from "@reduxjs/toolkit";
import { getItem, getJSON } from "../lib/storage.js";
import { homePanelFor, isModeAllowed, resolveModeForRole } from "../workspace/modes.js";
import { agentModeForMessages } from "../workspace/agentModes.js";
import { sessionEnded, sessionRestored, sessionStarted } from "../features/auth/sessionSlice.js";

const JOBS_TABS = ["matched", "campus", "market", "tracker", "detail"];
const ATTENTION_SOURCES = new Set(["copilot", "header"]);
const FOCUS_SOURCES = new Set(["user", "notification", "deeplink"]);

/** `available` (legacy) → `campus`; anything unknown → `matched`. */
export const normalizeJobsTab = (tab) => (tab === "available" ? "campus" : JOBS_TABS.includes(tab) ? tab : "matched");

const buildDetails = (user, previous = {}) => ({
  ...previous,
  name: user?.name || null,
  email: user?.email || null,
  phone: user?.phone || user?.mobileNumber || null,
  college: user?.collegeName || (typeof user?.college === "string" ? user.college : user?.college?.name) || null,
  branch: user?.branch || null,
  cgpa: user?.cgpa ?? null,
  skills: Array.isArray(user?.skills) ? user.skills : [],
  projects: Array.isArray(user?.projects) ? user.projects : [],
  certifications: Array.isArray(user?.certifications) ? user.certifications : [],
  experience: Array.isArray(user?.experience) ? user.experience : [],
  rollNumber: user?.rollNumber ?? null,
  section: user?.section ?? null,
  semester: user?.semester ?? null,
  department: user?.department ?? null,
  designation: user?.designation ?? null,
});

const workspaceDefaults = (mode) => ({
  activeMode: mode,
  activeFeature: null,
  activeJobsTab: "matched",
  activeResumeTool: null,
  activePanel: homePanelFor(mode),
  panelParams: {},
  panelData: {},
  panelNonce: {},
  overlay: null,
  mobilePane: "workspace",
  workspaceAttention: false,
  lastUiAction: null,
});

const readInitialState = () => {
  const user = getJSON("user");
  const role = user?.role || "student";
  const storedMode = getItem("activeMode");
  // Stale storage must never show AccessDenied: an invalid stored mode falls back silently.
  const mode = resolveModeForRole(role, storedMode === "admin" ? "tpo" : storedMode);
  return {
    user,
    userRole: role,
    agentMode: null,
    details: buildDetails(user),
    ...workspaceDefaults(mode),
  };
};

const applyUser = (state, user) => {
  state.user = user || null;
  state.userRole = user?.role || "student";
  state.details = buildDetails(user, state.details);
  if (!isModeAllowed(state.userRole, state.activeMode)) {
    Object.assign(state, workspaceDefaults(resolveModeForRole(state.userRole, null)));
  }
};

const appContextSlice = createSlice({
  name: "appContext",
  initialState: readInitialState,
  reducers: {
    setUserContext(state, action) {
      applyUser(state, action.payload);
    },
    /** @deprecated use switchMode()/openPanel() from src/workspace */
    setUserMode(state, action) {
      state.activeMode = action.payload;
    },
    setAgentMode(state, action) {
      state.agentMode = action.payload || null;
    },
    setActiveFeature(state, action) {
      state.activeFeature = action.payload ?? null;
    },
    setActiveJobsTab(state, action) {
      state.activeJobsTab = normalizeJobsTab(action.payload);
    },
    setActiveResumeTool(state, action) {
      state.activeResumeTool = action.payload || null;
    },
    setContextDetails(state, action) {
      state.details = { ...state.details, ...(action.payload || {}) };
    },
    clearAppContext(state) {
      Object.assign(state, { user: null, userRole: "student", agentMode: null, details: {}, ...workspaceDefaults("student") });
    },

    /** payload: { panelId, target, params, data, actionId, source, at } — dispatched by applyUiActions only. */
    panelOpened(state, action) {
      const { panelId, target, params, data, actionId = null, source = "user", at = null } = action.payload || {};
      if (!panelId || !target) return;
      if (target.kind === "overlay") {
        state.overlay = target.overlay;
      } else {
        state.activeMode = target.mode;
        if (target.feature !== undefined) state.activeFeature = target.feature;
        if (target.jobsTab !== undefined) state.activeJobsTab = normalizeJobsTab(target.jobsTab);
        if (target.resumeTool !== undefined) state.activeResumeTool = target.resumeTool;
        state.overlay = null;
        state.activePanel = panelId;
        if (FOCUS_SOURCES.has(source)) {
          state.mobilePane = "workspace";
          state.workspaceAttention = false;
        } else if (ATTENTION_SOURCES.has(source) && state.mobilePane !== "workspace") {
          state.workspaceAttention = true;
        }
      }
      state.panelParams[panelId] = params && typeof params === "object" ? params : {};
      if (data !== undefined) state.panelData[panelId] = data;
      else delete state.panelData[panelId];
      state.panelNonce[panelId] = (state.panelNonce[panelId] ?? 0) + 1;
      state.lastUiAction = { id: actionId, panelId, source, at };
    },
    /** payload: { panelId, params, replace } — usePanel().setParams; never bumps the nonce. */
    panelParamsUpdated(state, action) {
      const { panelId, params, replace = false } = action.payload || {};
      if (!panelId) return;
      const next = params && typeof params === "object" ? params : {};
      state.panelParams[panelId] = replace ? next : { ...(state.panelParams[panelId] ?? {}), ...next };
    },
    panelDataCleared(state, action) {
      delete state.panelData[action.payload];
    },
    overlayClosed(state) {
      state.overlay = null;
    },
    mobilePaneChanged(state, action) {
      state.mobilePane = action.payload === "chat" ? "chat" : "workspace";
      if (state.mobilePane === "workspace") state.workspaceAttention = false;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(sessionStarted, (state, action) => {
        const { user, conversation, initialMode } = action.payload || {};
        const role = user?.role || "student";
        Object.assign(state, {
          user: user || null,
          userRole: role,
          details: buildDetails(user),
          agentMode: agentModeForMessages(conversation?.messages),
          ...workspaceDefaults(resolveModeForRole(role, initialMode)),
        });
      })
      .addCase(sessionRestored, (state, action) => {
        applyUser(state, action.payload?.user ?? state.user);
      })
      .addCase(sessionEnded, (state) => {
        Object.assign(state, { user: null, userRole: "student", agentMode: null, details: {}, ...workspaceDefaults("student") });
      });
  },
});

export const {
  setUserContext,
  setUserMode,
  setAgentMode,
  setActiveFeature,
  setActiveJobsTab,
  setActiveResumeTool,
  setContextDetails,
  clearAppContext,
  panelOpened,
  panelParamsUpdated,
  panelDataCleared,
  overlayClosed,
  mobilePaneChanged,
} = appContextSlice.actions;

// Read-only selectors for every owner (FRONTEND.md §7.1).
export const selectAIContext = (state) => state.appContext;
export const selectUser = (state) => state.appContext.user;
export const selectUserRole = (state) => state.appContext.userRole;
export const selectActiveMode = (state) => state.appContext.activeMode;
export const selectActiveFeature = (state) => state.appContext.activeFeature;
export const selectActiveJobsTab = (state) => state.appContext.activeJobsTab;
export const selectActiveResumeTool = (state) => state.appContext.activeResumeTool;
export const selectActivePanel = (state) => state.appContext.activePanel;
export const selectOverlay = (state) => state.appContext.overlay;
export const selectAgentMode = (state) => state.appContext.agentMode;
export const selectMobilePane = (state) => state.appContext.mobilePane;
export const selectWorkspaceAttention = (state) => state.appContext.workspaceAttention;

export default appContextSlice.reducer;
