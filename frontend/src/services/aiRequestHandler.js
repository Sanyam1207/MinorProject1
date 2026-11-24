// AI chat transport: sends `query` over the shared socket, routes every
// `response` chunk into Redux and turns headers / copilot tool results into
// UI actions for the right-hand workspace (FRONTEND.md §8).
import { ensureSocketAuthentication, socket } from "../lib/socket.js";
import {
  connectionChanged,
  conversationOpened,
  ensureWelcomeMessage,
  interviewTranscriptUpdated,
  newChatStarted,
  requestFailed,
  requestStarted,
  responseReceived,
} from "../store/aiChatSlice.js";
import { setActiveJobsTab, setAgentMode } from "../store/appContextSlice.js";
import { bootstrapSession } from "../features/auth/session.js";
import { toastError, toastSuccess } from "../ui/toast.js";
import { agentModeForHeader, agentModeForMessages, isCopilotHeader, isFailureHeader } from "../workspace/agentModes.js";
import { copilotUiActions, routeHeader } from "../workspace/headerRoutes.js";
import { isModeAllowed } from "../workspace/modes.js";
import { resolveTarget } from "../workspace/panels.js";
import { applyUiActions } from "../workspace/uiActions.js";
import { getAIFeature } from "./aiFeatureRegistry.js";

export { AGENT_MODE_BY_HEADER } from "../workspace/agentModes.js";

// Longer than Node's 120 s AI_IDLE_TIMEOUT_MS, so Node's terminal chunk normally arrives first.
const RESPONSE_TIMEOUT_MS = 130000;
const FALLBACK_ERROR_TEXT = "I am having trouble fetching live DB tool data at the moment. Please try asking again!";

const newId = () => crypto.randomUUID();

const userSummary = (user, role) =>
  user
    ? {
      id: user._id || user.id || null,
      name: user.name || null,
      email: user.email || null,
      role,
      branch: user.branch || null,
      skills: Array.isArray(user.skills) ? user.skills : [],
    }
    : null;

const pastMessages = (messages) =>
  messages.slice(-8).map((message) => ({
    role: message.sender === "user" ? "user" : "assistant",
    content: message.text || "",
  }));

/** What the copilot should know about the workspace on screen (FRONTEND.md §8.1). */
const uiContextFor = (appContext) => ({
  mode: appContext.activeMode,
  panel: appContext.activePanel,
  params: appContext.panelParams[appContext.activePanel] ?? {},
});

/** mode_name: explicit → mode-implied → sticky agent → teacher copilot → null (FRONTEND.md §8.1). */
const resolveModeName = (modeName, appContext) =>
  modeName ||
  (appContext.activeMode === "pr_outreach" ? "pr_outreach" : appContext.activeMode === "alumni_connect" ? "alumni-connect" : null) ||
  appContext.agentMode ||
  (appContext.activeMode === "teacher" ? "copilot" : null) ||
  null;

class AIRequestHandler {
  constructor() {
    this.store = null;
    this.timeouts = new Map();
    this.initialized = false;
  }

  initialize(store) {
    if (this.initialized) return;
    this.store = store;
    this.initialized = true;

    socket.on("connect", () => store.dispatch(connectionChanged(true)));
    socket.on("disconnect", () => store.dispatch(connectionChanged(false)));
    socket.on("response", (payload) => this.handleResponse(payload));
    socket.on("interview:transcript", (payload) => {
      store.dispatch(interviewTranscriptUpdated(payload));
      if (payload?.isFinal) this.armTimeout(payload.requestId);
    });
    socket.on("interview:audio:error", (payload) => {
      if (!payload?.requestId || payload.code === "TTS_FAILED") return;
      const request = store.getState().aiChat.requests[payload.requestId];
      if (request && request.status !== "completed" && request.status !== "failed") {
        this.clearTimeout(payload.requestId);
        store.dispatch(requestFailed({ requestId: payload.requestId, message: payload.message }));
      }
    });
    store.dispatch(connectionChanged(socket.connected));

    const state = store.getState();
    // A reload restores the sticky agent from the last bot message (so "Confirm" still reaches the copilot).
    store.dispatch(setAgentMode(agentModeForMessages(state.aiChat.messages)));
    const user = state.appContext.user;
    if (user) store.dispatch(ensureWelcomeMessage({ name: user.name, role: user.role }));
  }

  send({ text, details = {}, modeName, source = "chat", feature = null }) {
    if (!this.store) throw new Error("AI request handler has not been initialized");

    const cleanText = String(text || "").trim();
    if (!cleanText) return null;

    const state = this.store.getState();
    const { appContext, aiChat } = state;
    const requestId = newId();
    const createdAt = new Date().toISOString();
    const effectiveModeName = resolveModeName(modeName, appContext);
    const payload = {
      requestId,
      sessionId: aiChat.sessionId,
      user_query: cleanText,
      user_role: appContext.userRole,
      user_mode: appContext.activeMode,
      mode_name: effectiveModeName,
      source,
      feature,
      user: userSummary(appContext.user, appContext.userRole),
      details: {
        ...appContext.details,
        selected_job: aiChat.journey.selectedJob,
        resume: aiChat.journey.resume,
        ...details,
        ui_context: details?.ui_context ?? uiContextFor(appContext),
      },
      past_messages: pastMessages(aiChat.messages),
    };
    if (
      (effectiveModeName === "pr_outreach" || effectiveModeName === "pr-outreach") &&
      aiChat.prOutreachWorkspace.sendStatus !== "sent"
    ) {
      const draft = aiChat.prOutreachWorkspace;
      payload.mail_draft = {
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        status: draft.status,
        confidence_score: draft.confidenceScore,
      };
    }
    if (
      (effectiveModeName === "alumni-connect" || effectiveModeName === "alumni_connect") &&
      aiChat.alumniWorkspace.draft &&
      aiChat.alumniWorkspace.sendStatus !== "sent"
    ) {
      const draft = aiChat.alumniWorkspace.draft;
      payload.alumni_request_draft = {
        alumni_id: draft.alumni_id,
        alumni_name: draft.alumni_name,
        request_type: draft.request_type,
        message: draft.message,
        selected_job: draft.selected_job,
        share_resume: Boolean(draft.share_resume),
        resume: draft.share_resume ? draft.resume : "",
        status: draft.status,
      };
    }
    if (
      (effectiveModeName === "alumni-connect" || effectiveModeName === "alumni_connect") &&
      aiChat.alumniWorkspace.resumeShareDraft &&
      aiChat.alumniWorkspace.resumeShareStatus !== "shared"
    ) {
      payload.resume_share_draft = aiChat.alumniWorkspace.resumeShareDraft;
    }

    this.store.dispatch(
      requestStarted({
        requestId,
        userMessageId: newId(),
        assistantMessageId: newId(),
        text: cleanText,
        createdAt,
        payload,
      }),
    );

    if (modeName) this.store.dispatch(setAgentMode(modeName));

    ensureSocketAuthentication();
    socket.emit("query", payload);
    this.armTimeout(requestId);

    return { requestId, sessionId: payload.sessionId };
  }

  startInterviewAudio({ sampleRate, questionNumber, onAcknowledged }) {
    if (!this.store) throw new Error("AI request handler has not been initialized");

    const { appContext, aiChat } = this.store.getState();
    const requestId = newId();
    const createdAt = new Date().toISOString();
    const payload = {
      requestId,
      sessionId: aiChat.sessionId,
      user_role: appContext.userRole,
      user_mode: "student",
      mode_name: "ai-interviewer",
      source: "interview-voice-stream",
      feature: "mock-interview",
      sampleRate,
      language: "en-IN",
      questionNumber,
      user: userSummary(appContext.user, appContext.userRole),
      details: {
        ...appContext.details,
        selected_job: aiChat.journey.selectedJob,
        resume: aiChat.journey.resume,
        input_type: "voice",
        speech_language: "en-IN",
        ui_context: uiContextFor(appContext),
      },
      past_messages: pastMessages(aiChat.messages),
    };

    this.store.dispatch(
      requestStarted({
        requestId,
        userMessageId: newId(),
        assistantMessageId: newId(),
        text: "🎙️ Listening…",
        createdAt,
        payload,
      }),
    );
    this.store.dispatch(setAgentMode("ai-interviewer"));
    ensureSocketAuthentication();
    socket.emit("interview:audio:start", payload, (result) => onAcknowledged?.(result));
    return { requestId, sessionId: payload.sessionId };
  }

  endInterviewAudio(requestId) {
    if (requestId) socket.emit("interview:audio:end", { requestId });
  }

  cancelInterviewAudio(requestId) {
    if (requestId) socket.emit("interview:audio:cancel", { requestId });
  }

  /** Tile/button AI features: role-checked panel open + default prompt (deduped while running). */
  runFeature(featureId) {
    if (!this.store) throw new Error("AI request handler has not been initialized");

    const feature = getAIFeature(featureId);
    if (!feature) return null;

    const state = this.store.getState();
    const role = state.appContext.userRole;
    const targetMode = resolveTarget(feature.panel, role, feature.params ?? {})?.mode;
    if (!feature.roles.includes(role) || !targetMode || !isModeAllowed(role, targetMode)) {
      toastError("Not available for your role");
      return null;
    }
    applyUiActions([{ panel: feature.panel, params: feature.params }], { source: "user" });

    const activeRequest = Object.values(state.aiChat.requests).find(
      (request) => request.feature === feature.id && (request.status === "pending" || request.status === "streaming"),
    );
    if (activeRequest) return { requestId: activeRequest.requestId, sessionId: state.aiChat.sessionId };

    return this.send({
      text: feature.defaultPrompt,
      modeName: feature.agentMode,
      source: "feature-card",
      feature: feature.id,
    });
  }

  handleResponse(payload) {
    if (!payload?.requestId || !this.store) return;
    const { dispatch } = this.store;
    const request = this.store.getState().aiChat.requests[payload.requestId];
    if (!request || request.status === "failed") return;

    // 1–2. Message + workspaces.
    dispatch(responseReceived(payload));

    // 3. Sticky agent mode.
    const header = payload.header_message;
    const routedAgentMode = agentModeForHeader(header);
    if (routedAgentMode) dispatch(setAgentMode(routedAgentMode));

    // 4. UI actions (role-checked; deduped per request).
    if (isCopilotHeader(header)) {
      const actions = copilotUiActions(payload);
      if (actions.length) applyUiActions(actions, { source: "copilot", requestId: payload.requestId });
    } else {
      const actions = routeHeader(payload);
      if (actions.length) applyUiActions(actions, { source: "header", requestId: payload.requestId });
    }

    // 5. Terminal failures release every busy workspace.
    if (payload.isEnd && (isFailureHeader(header) || payload.data?.type === "error")) {
      dispatch(
        requestFailed({
          requestId: payload.requestId,
          message: payload.response || payload.data?.message || FALLBACK_ERROR_TEXT,
          header,
        }),
      );
      if (header === "auth:required") dispatch(bootstrapSession());
    }

    // 6. Wishlist / tracker result.
    if (header === "mode:jobparser:addjob:wishlist" && payload.data?.type === "wishlist") {
      if (payload.data.ok) toastSuccess(payload.response || "Saved to your job tracker");
      else toastError(payload.response || "Couldn't update your job tracker");
    }

    // 7. Inactivity timer.
    if (payload.isEnd) this.clearTimeout(payload.requestId);
    else this.armTimeout(payload.requestId);
  }

  armTimeout(requestId) {
    if (!requestId) return;
    this.clearTimeout(requestId);
    const timeout = setTimeout(() => {
      this.timeouts.delete(requestId);
      this.store.dispatch(requestFailed({ requestId, message: FALLBACK_ERROR_TEXT }));
    }, RESPONSE_TIMEOUT_MS);
    this.timeouts.set(requestId, timeout);
  }

  clearTimeout(requestId) {
    const timeout = this.timeouts.get(requestId);
    if (timeout) clearTimeout(timeout);
    this.timeouts.delete(requestId);
  }

  clearAllTimeouts() {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
  }

  startNewChat(name) {
    if (!this.store) return;
    this.clearAllTimeouts();
    const user = this.store.getState().appContext.user;
    this.store.dispatch(setAgentMode(null));
    this.store.dispatch(setActiveJobsTab("matched"));
    this.store.dispatch(newChatStarted({ name: name || user?.name, role: user?.role }));
  }

  openConversation(sessionId) {
    if (!this.store) return;
    this.clearAllTimeouts();
    this.store.dispatch(conversationOpened(sessionId));
    this.store.dispatch(setAgentMode(agentModeForMessages(this.store.getState().aiChat.messages)));
  }
}

export const aiRequestHandler = new AIRequestHandler();

export const sendAIMessage = (payload) => () => aiRequestHandler.send(payload);
export const startInterviewAudio = (payload) => () => aiRequestHandler.startInterviewAudio(payload);
export const endInterviewAudio = (requestId) => () => aiRequestHandler.endInterviewAudio(requestId);
export const cancelInterviewAudio = (requestId) => () => aiRequestHandler.cancelInterviewAudio(requestId);
export const runAIFeature = (featureId) => () => aiRequestHandler.runFeature(featureId);
export const startNewAIChat = (name) => () => aiRequestHandler.startNewChat(name);
export const openAIConversation = (sessionId) => () => aiRequestHandler.openConversation(sessionId);
