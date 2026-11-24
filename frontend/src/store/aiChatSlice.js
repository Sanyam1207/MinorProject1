import { createSelector, createSlice } from "@reduxjs/toolkit";
import { APP_NAME } from "../lib/config.js";
import { getJSON } from "../lib/storage.js";
import { sessionEnded, sessionStarted } from "../features/auth/sessionSlice.js";

const FALLBACK_ERROR_TEXT = "I am having trouble fetching live DB tool data at the moment. Please try asking again!";
const INTERRUPTED = "Interrupted";
const MAX_ARCHIVED_SESSIONS = 20;
const MAX_INTERVIEW_HISTORY = 20;

const newId = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const nowIso = () => new Date().toISOString();

// ─── Identity & storage keys ──────────────────────────────────────────────────

/** Per-user storage identity: id, else email, else "guest". */
export const chatIdentity = (user) => user?._id || user?.id || user?.email || "guest";
export const chatHistoryKey = (identity) => `placement-ai-chat-history:${identity}`;
export const interviewHistoryKey = (identity) => `interview-history:${identity}`;

// ─── Message normalisation (hydration) ───────────────────────────────────────

const normalizeToolCall = (call, index) => ({
  id: String(call?.id ?? `call-${index}`),
  name: typeof call?.name === "string" ? call.name : "tool",
  args: call?.args && typeof call.args === "object" ? call.args : {},
  status: ["running", "done", "error", "needs_confirmation"].includes(call?.status) ? call.status : "done",
  summary: typeof call?.summary === "string" ? call.summary : null,
  error: typeof call?.error === "string" ? call.error : call?.error ? String(call.error) : null,
});

const interruptToolCalls = (toolCalls) =>
  Array.isArray(toolCalls)
    ? toolCalls.map((call) => (call?.status === "running" ? { ...call, status: "error", error: INTERRUPTED } : call))
    : toolCalls;

/** Stored messages never pulse forever and never show a spinning tool call. */
export const normalizeStoredMessage = (message) => {
  if (!message || typeof message !== "object") return null;
  const normalized = { ...message, streaming: false };
  if (Array.isArray(message.toolCalls)) normalized.toolCalls = interruptToolCalls(message.toolCalls);
  return normalized;
};

const normalizeMessages = (messages) =>
  Array.isArray(messages) ? messages.map(normalizeStoredMessage).filter(Boolean) : [];

const normalizeSessions = (sessions) =>
  Array.isArray(sessions)
    ? sessions
      .filter((session) => session && typeof session === "object" && session.sessionId)
      .map((session) => ({ ...session, messages: normalizeMessages(session.messages) }))
      .slice(0, MAX_ARCHIVED_SESSIONS)
    : [];

const normalizeConversation = (stored) => {
  if (Array.isArray(stored)) return { sessionId: newId(), messages: normalizeMessages(stored), sessions: [] };
  if (stored && typeof stored === "object" && Array.isArray(stored.messages)) {
    return {
      ...stored,
      sessionId: stored.sessionId || newId(),
      messages: normalizeMessages(stored.messages),
      sessions: normalizeSessions(stored.sessions),
    };
  }
  return { sessionId: newId(), messages: [], sessions: [] };
};

/** Interview history for a user; falls back to the old global key on first read. */
export const readInterviewHistory = (identity) => {
  const own = getJSON(interviewHistoryKey(identity));
  if (Array.isArray(own)) return own.slice(0, MAX_INTERVIEW_HISTORY);
  if (identity !== "guest") {
    const legacy = getJSON("interview-history");
    if (Array.isArray(legacy)) return legacy.slice(0, MAX_INTERVIEW_HISTORY);
  }
  return [];
};

/** Stored conversation (+ interview history) for a user, normalised for hydration. */
export const readConversationForUser = (user) => {
  const identity = chatIdentity(user);
  return {
    ...normalizeConversation(getJSON(chatHistoryKey(identity))),
    interviewHistory: readInterviewHistory(identity),
  };
};

const readStoredConversation = () => readConversationForUser(getJSON("user"));

// ─── Persistence shape (used by the quota-safe persister in store/index.js) ──

const MAX_TEXT_CHARS = 20000;
const MAX_INLINE_RESUME_CHARS = 50000;

const trimMessageForStorage = (message) => {
  const trimmed = { ...message, streaming: false };
  if (typeof trimmed.text === "string" && trimmed.text.length > MAX_TEXT_CHARS) {
    trimmed.text = `${trimmed.text.slice(0, MAX_TEXT_CHARS)}\n\n…`;
  }
  if (Array.isArray(trimmed.uiActions)) {
    trimmed.uiActions = trimmed.uiActions.map(({ id, panel, params }) => ({ id, panel, params }));
  }
  return trimmed;
};

const trimJourney = (journey, keepResume) => {
  const resume = typeof journey?.resume === "string" ? journey.resume : "";
  return {
    selectedJob: journey?.selectedJob ?? null,
    resume: keepResume && resume.length <= MAX_INLINE_RESUME_CHARS ? resume : "",
  };
};

const trimInterviewWorkspace = (workspace) => {
  if (!workspace || typeof workspace !== "object") return undefined;
  const rest = { ...workspace };
  delete rest.dbJobs;
  delete rest.resources;
  return rest;
};

const STORAGE_LEVELS = [
  { sessions: MAX_ARCHIVED_SESSIONS, messages: 200, keepResume: true },
  { sessions: 5, messages: 80, keepResume: false },
  { sessions: 0, messages: 30, keepResume: false },
];

/**
 * Serializable chat snapshot for localStorage. `level` 0..2 = progressively
 * smaller (used after a QuotaExceededError). LaTeX, interview job lists and
 * one-shot UI payloads never go to storage.
 */
export function chatStorageSnapshot(aiChat, level = 0) {
  const limits = STORAGE_LEVELS[Math.min(Math.max(level, 0), STORAGE_LEVELS.length - 1)];
  return {
    sessionId: aiChat.sessionId,
    messages: aiChat.messages.slice(-limits.messages).map(trimMessageForStorage),
    sessions: aiChat.sessions.slice(0, limits.sessions).map((session) => ({
      ...session,
      messages: (session.messages || []).slice(-limits.messages).map(trimMessageForStorage),
      interviewWorkspace: trimInterviewWorkspace(session.interviewWorkspace),
      journey: trimJourney(session.journey, false),
    })),
    prOutreachWorkspace: aiChat.prOutreachWorkspace,
    alumniWorkspace: aiChat.alumniWorkspace,
    journey: trimJourney(aiChat.journey, limits.keepResume),
  };
}

export const CHAT_STORAGE_LEVELS = STORAGE_LEVELS.length;

// ─── Empty workspace factories ────────────────────────────────────────────────

const emptyResumeWorkspace = () => ({ latexCode: "", status: "idle", pdfUrl: null, error: null, requestId: null, analysis: null });

const emptyJobCreationWorkspace = () => ({
  status: "idle",
  job: null,
  missingFields: [],
  awaitingConfirmation: false,
  persistedJobId: null,
  error: null,
  requestId: null,
});

const emptyPROutreachWorkspace = () => ({
  to: "",
  subject: "",
  body: "",
  status: "idle",
  agentSatisfied: false,
  confidenceScore: null,
  sendStatus: "idle",
  sendError: null,
  sentAt: null,
  messageId: null,
  error: null,
  requestId: null,
  lastSyncedAt: null,
});

const emptyAlumniWorkspace = () => ({
  matches: [],
  draft: null,
  status: "idle",
  agentReviewed: false,
  sendStatus: "idle",
  sendError: null,
  requestId: null,
  resumeShareDraft: null,
  resumeShareReviewed: false,
  resumeShareStatus: "idle",
  resumeShareError: null,
});

const emptyInterviewWorkspace = () => ({
  status: "idle",
  options: [],
  dbJobs: [],
  selectedJob: null,
  currentQuestion: "",
  questionNumber: 0,
  topic: "",
  secondsRemaining: 0,
  report: null,
  reason: null,
  error: null,
  requestId: null,
  resources: null,
});

const emptyGapAnalysisWorkspace = () => ({
  status: "idle",
  gaps: [],
  suggestions: [],
  confidenceScore: null,
  error: null,
  requestId: null,
});

const emptyLearningWorkspace = () => ({
  status: "idle",
  interviews: [],
  selectedInterview: null,
  recommendations: null,
  error: null,
  requestId: null,
});

const emptyJourney = () => ({ selectedJob: null, resume: "" });

// Busy states that a terminal failure must release (requestFailed).
const resetTransientWorkspaces = (state) => {
  state.requests = {};
  state.latestJobs = [];
  state.latestAgentData = null;
  state.latestUiTarget = null;
  state.resumeWorkspace = emptyResumeWorkspace();
  state.jobCreationWorkspace = emptyJobCreationWorkspace();
  state.gapAnalysisWorkspace = emptyGapAnalysisWorkspace();
  state.learningWorkspace = emptyLearningWorkspace();
};

const hydrateConversation = (state, conversation = {}) => {
  state.sessionId = conversation.sessionId || state.sessionId || newId();
  state.messages = normalizeMessages(conversation.messages);
  state.sessions = normalizeSessions(conversation.sessions);
  resetTransientWorkspaces(state);
  state.prOutreachWorkspace = { ...emptyPROutreachWorkspace(), ...(conversation.prOutreachWorkspace || {}) };
  state.alumniWorkspace = { ...emptyAlumniWorkspace(), ...(conversation.alumniWorkspace || {}) };
  state.interviewWorkspace = { ...emptyInterviewWorkspace(), ...(conversation.interviewWorkspace || {}) };
  state.journey = { ...emptyJourney(), ...(conversation.journey || {}) };
  if (Array.isArray(conversation.interviewHistory)) {
    state.interviewHistory = conversation.interviewHistory.slice(0, MAX_INTERVIEW_HISTORY);
  }
};

// ─── Welcome message ─────────────────────────────────────────────────────────

const WELCOME_OPTIONS = Object.freeze({
  student: ["Show my attendance", "Find campus drives for me", "Tailor my resume for a job"],
  teacher: ["Schedule DBMS tomorrow at 10am", "Start attendance for my next class", "Who is below 75% in my courses?"],
  tpo: ["Show placement stats", "List active drives", "Offers awaiting response"],
  admin: ["Show placement stats", "List active drives", "Offers awaiting response"],
  company: ["List my drives"],
  alumni: ["Show my mentorship requests"],
});

/** Accepts a name string or `{ name, role }`. */
const toWelcomeArg = (arg) => {
  if (arg && typeof arg === "object") return { name: arg.name || "there", role: arg.role || null };
  return { name: typeof arg === "string" && arg.trim() ? arg.trim() : "there", role: null };
};

const buildWelcomeMessage = ({ name, role, id, createdAt }) => ({
  id: id || newId(),
  sender: "bot",
  text: `Hello ${name}! I'm your ${APP_NAME} copilot. How can I help?`,
  headerMessage: null,
  streaming: false,
  createdAt: createdAt || nowIso(),
  ...(WELCOME_OPTIONS[role] ? { options: [...WELCOME_OPTIONS[role]] } : {}),
});

const prepareWelcome = (arg) => ({
  payload: { ...toWelcomeArg(arg), id: newId(), createdAt: nowIso(), sessionId: newId() },
});

// ─── Session archive ─────────────────────────────────────────────────────────

const toSessionRecord = (state) => {
  const firstUserMessage = state.messages.find((message) => message.sender === "user");
  if (!firstUserMessage) return null;
  const lastMessage = state.messages[state.messages.length - 1];
  return {
    sessionId: state.sessionId,
    title: firstUserMessage.text || "Untitled conversation",
    createdAt: firstUserMessage.createdAt || lastMessage?.createdAt || null,
    updatedAt: lastMessage?.createdAt || firstUserMessage.createdAt || null,
    messages: state.messages.map((message) => normalizeStoredMessage(message)),
    prOutreachWorkspace: { ...state.prOutreachWorkspace },
    alumniWorkspace: { ...state.alumniWorkspace },
    interviewWorkspace: { ...state.interviewWorkspace },
    journey: { ...state.journey },
  };
};

const archiveCurrentSession = (state) => {
  const current = toSessionRecord(state);
  if (!current) return;
  state.sessions = [current, ...state.sessions.filter((session) => session.sessionId !== current.sessionId)].slice(
    0,
    MAX_ARCHIVED_SESSIONS,
  );
};

// ─── Copilot chunk (AGENT-TOOLS.md §6) ───────────────────────────────────────

const applyCopilotChunk = (message, payload) => {
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const header = payload.header_message;
  message.text = payload.response || data.message || message.text || FALLBACK_ERROR_TEXT;
  if (Array.isArray(data.tool_calls)) message.toolCalls = data.tool_calls.map(normalizeToolCall);
  else if (!Array.isArray(message.toolCalls)) message.toolCalls = [];
  if (Array.isArray(data.ui_actions)) {
    message.uiActions = data.ui_actions
      .filter((action) => action && typeof action.panel === "string")
      .map((action, index) => ({ id: String(action.id ?? index), panel: action.panel, params: action.params ?? {} }));
  } else if (!Array.isArray(message.uiActions)) {
    message.uiActions = [];
  }
  message.pending = header === "copilot:confirm" && data.pending && typeof data.pending === "object" ? data.pending : null;
  message.copilotPhase = typeof data.phase === "string" ? data.phase : header.split(":")[1] || null;
  const options = Array.isArray(payload.options) && payload.options.length > 0 ? payload.options : data.options;
  if (Array.isArray(options) && options.length > 0) {
    message.options = options.map((option) => (typeof option === "string" ? option : option?.label || option?.value || String(option)));
  }
};

// ─── Slice ────────────────────────────────────────────────────────────────────

const readInitialState = () => {
  const stored = readStoredConversation();
  return {
    sessionId: stored.sessionId || newId(),
    messages: stored.messages || [],
    sessions: stored.sessions || [],
    requests: {},
    connected: false,
    latestJobs: [],
    latestAgentData: null,
    latestUiTarget: null,
    resumeWorkspace: emptyResumeWorkspace(),
    jobCreationWorkspace: emptyJobCreationWorkspace(),
    prOutreachWorkspace: { ...emptyPROutreachWorkspace(), ...(stored.prOutreachWorkspace || {}) },
    alumniWorkspace: { ...emptyAlumniWorkspace(), ...(stored.alumniWorkspace || {}) },
    interviewWorkspace: { ...emptyInterviewWorkspace(), ...(stored.interviewWorkspace || {}) },
    gapAnalysisWorkspace: emptyGapAnalysisWorkspace(),
    learningWorkspace: emptyLearningWorkspace(),
    interviewHistory: stored.interviewHistory || [],
    journey: { ...emptyJourney(), ...(stored.journey || {}) },
  };
};

const aiChatSlice = createSlice({
  name: "aiChat",
  initialState: readInitialState,
  reducers: {
    connectionChanged(state, action) {
      state.connected = Boolean(action.payload);
    },

    conversationHydrated: {
      reducer(state, action) {
        hydrateConversation(state, action.payload || {});
      },
      prepare(conversation) {
        return { payload: { ...(conversation || {}), sessionId: conversation?.sessionId || newId() } };
      },
    },

    /** Accepts a name string or `{ name, role }`; no-op when the chat already has messages. */
    ensureWelcomeMessage: {
      reducer(state, action) {
        if (state.messages.length > 0) return;
        state.messages.push(buildWelcomeMessage(action.payload));
      },
      prepare: prepareWelcome,
    },

    requestStarted(state, action) {
      const { requestId, userMessageId, assistantMessageId, text, createdAt, payload } = action.payload;
      state.requests[requestId] = {
        requestId,
        assistantMessageId,
        feature: payload?.feature || null,
        source: payload?.source || "chat",
        modeName: payload?.mode_name || null,
        status: "pending",
        error: null,
      };
      state.messages.push({ id: userMessageId, requestId, sender: "user", text, createdAt, streaming: false });
      state.messages.push({
        id: assistantMessageId,
        requestId,
        sender: "bot",
        text: "",
        headerMessage: null,
        createdAt,
        streaming: true,
      });
      if (payload?.mode_name === "resume-generator") {
        state.resumeWorkspace.status = "collecting";
        state.resumeWorkspace.error = null;
        state.resumeWorkspace.requestId = requestId;
      }
      if (payload?.mode_name === "job-creation") {
        state.jobCreationWorkspace.status = "collecting";
        state.jobCreationWorkspace.error = null;
        state.jobCreationWorkspace.requestId = requestId;
      }
      if (payload?.mode_name === "pr_outreach" || payload?.mode_name === "pr-outreach") {
        if (payload?.source !== "pr-outreach-mail-sent") {
          state.prOutreachWorkspace.status = "drafting";
          state.prOutreachWorkspace.agentSatisfied = false;
        }
        state.prOutreachWorkspace.error = null;
        state.prOutreachWorkspace.requestId = requestId;
      }
      if (payload?.mode_name === "alumni-connect" || payload?.mode_name === "alumni_connect") {
        state.alumniWorkspace.status = "working";
        state.alumniWorkspace.sendError = null;
        state.alumniWorkspace.requestId = requestId;
      }
      if (payload?.mode_name === "ai-interviewer") {
        state.interviewWorkspace.status =
          state.interviewWorkspace.status === "complete" || state.interviewWorkspace.status === "idle"
            ? "starting"
            : state.interviewWorkspace.status;
        state.interviewWorkspace.error = null;
        state.interviewWorkspace.requestId = requestId;
      }
      if (payload?.mode_name === "gap-analysis") {
        state.gapAnalysisWorkspace.status = "analysing";
        state.gapAnalysisWorkspace.error = null;
        state.gapAnalysisWorkspace.requestId = requestId;
      }
      if (payload?.mode_name === "learning-recommendation") {
        state.learningWorkspace.status = state.learningWorkspace.selectedInterview ? "generating" : "idle";
        state.learningWorkspace.error = null;
        state.learningWorkspace.requestId = requestId;
      }
    },

    responseReceived(state, action) {
      const payload = action.payload;
      const request = state.requests[payload.requestId];
      if (!request) return;
      const header = typeof payload.header_message === "string" ? payload.header_message : null;
      const isCopilot = Boolean(header?.startsWith("copilot:"));

      const message = state.messages.find((item) => item.id === request.assistantMessageId);
      if (message) {
        if (isCopilot) {
          applyCopilotChunk(message, payload);
        } else {
          // Resume-generator text chunks are DELTAS (appended); every other header is cumulative.
          const isResumeResponse =
            request.modeName === "resume-generator" || header === "resume_generator" || header === "resume-generator";
          if (isResumeResponse && payload.data?.type === "text") {
            message.text += payload.response || "";
          } else if (!isResumeResponse || payload.response) {
            message.text = payload.response || message.text || FALLBACK_ERROR_TEXT;
          }
          if (Array.isArray(payload.options) && payload.options.length > 0) {
            message.options = payload.options;
          } else if (header === "button:options" && Array.isArray(payload.data?.options)) {
            message.options = payload.data.options.map((opt) =>
              typeof opt === "string" ? opt : opt.label || opt.value || String(opt),
            );
          }
        }
        message.headerMessage = header;
        message.streaming = !payload.isEnd;
      }

      request.status = payload.isEnd ? "completed" : "streaming";
      request.error = null;

      if (payload.data !== undefined) {
        state.latestAgentData = payload.data;
      }
      if (isCopilot) {
        state.latestUiTarget = "copilot";
        return;
      }

      // ── Resume generator ──
      if (header === "resume_generator" || header === "resume-generator") {
        state.latestUiTarget = "resume.generator";
        if (payload.data?.type === "latex") {
          if (state.resumeWorkspace.status !== "streaming") state.resumeWorkspace.latexCode = "";
          state.resumeWorkspace.latexCode += payload.data.content || "";
          state.resumeWorkspace.status = payload.data.status === "complete" ? "complete" : "streaming";
          state.resumeWorkspace.requestId = payload.requestId;
          if (payload.data.status === "complete") {
            state.journey.resume = state.resumeWorkspace.latexCode;
            if (payload.data.target_job) state.journey.selectedJob = payload.data.target_job;
          }
        } else if (payload.data?.type === "text" && payload.isEnd) {
          state.resumeWorkspace.status = "collecting";
        } else if (payload.data?.type === "analysis") {
          state.resumeWorkspace.analysis = payload.data;
          state.resumeWorkspace.status = "analysis";
          state.latestUiTarget = payload.data.analysis_type === "gap" ? "resume.skill-gap" : "resume.ats-score";
        }
        if (payload.pdfUrl) state.resumeWorkspace.pdfUrl = payload.pdfUrl;
      }

      // ── Job creation ──
      if (header?.startsWith("mode:jobCreation:")) {
        const headerStatus = header.split(":").at(-1);
        state.latestUiTarget = "tpo.job-creator";
        state.jobCreationWorkspace.status =
          payload.data?.status || (payload.data?.type === "confirmation" ? "confirmation" : headerStatus);
        state.jobCreationWorkspace.job = payload.data?.job || state.jobCreationWorkspace.job;
        state.jobCreationWorkspace.missingFields = payload.data?.missing_fields || [];
        state.jobCreationWorkspace.awaitingConfirmation = payload.data?.type === "confirmation";
        state.jobCreationWorkspace.persistedJobId =
          payload.data?.persisted_job_id || state.jobCreationWorkspace.persistedJobId;
        state.jobCreationWorkspace.error = headerStatus === "error" ? payload.response : null;
        state.jobCreationWorkspace.requestId = payload.requestId;
      }

      // ── PR Outreach ──
      if (header === "mail:review" || header === "pr_outreach_satisfied") {
        const draft = payload.data?.email || payload.data || {};
        state.latestUiTarget = "pr-outreach.composer";
        if (typeof draft.to === "string") state.prOutreachWorkspace.to = draft.to;
        if (typeof draft.subject === "string") state.prOutreachWorkspace.subject = draft.subject;
        if (typeof draft.body === "string") state.prOutreachWorkspace.body = draft.body;
        if (header === "pr_outreach_satisfied") {
          state.prOutreachWorkspace.agentSatisfied = true;
          state.prOutreachWorkspace.status = "satisfied";
        } else {
          state.prOutreachWorkspace.status = "review";
          state.prOutreachWorkspace.sendStatus = "idle";
          state.prOutreachWorkspace.sendError = null;
          state.prOutreachWorkspace.sentAt = null;
          state.prOutreachWorkspace.messageId = null;
        }
        if (Number.isFinite(payload.confidence_score)) {
          state.prOutreachWorkspace.confidenceScore = payload.confidence_score;
        }
        state.prOutreachWorkspace.error = null;
        state.prOutreachWorkspace.requestId = payload.requestId;
        state.prOutreachWorkspace.lastSyncedAt = nowIso();
      }

      // ── Jobs list / details / wishlist ──
      if (header === "mode:jobparser:jobslist" && Array.isArray(payload.data) && payload.data.length > 0) {
        state.latestJobs = payload.data;
        state.latestUiTarget = "student.jobs";
      }
      if (header === "mode:jobparser:jobdetails") {
        const data = payload.data;
        state.journey.selectedJob =
          data?.selected_job ??
          (data?.type === "job_details" ? data.job : data?.title ? data : state.journey.selectedJob);
      }
      if (
        header === "mode:jobparser:addjob:wishlist" &&
        payload.data?.type === "wishlist" &&
        payload.data.ok &&
        payload.data.job_id
      ) {
        const saved = state.latestJobs.find((job) => String(job?.id ?? job?._id ?? "") === String(payload.data.job_id));
        if (saved) saved.application_status = payload.data.status ?? saved.application_status ?? null;
      }

      // ── Alumni ──
      if (header === "alumni:matches" && Array.isArray(payload.data)) {
        state.latestUiTarget = "alumni.matches";
        state.alumniWorkspace.matches = payload.data;
        state.alumniWorkspace.status = "matches";
        state.alumniWorkspace.requestId = payload.requestId;
      }
      if (header === "alumni:request-review") {
        state.latestUiTarget = "alumni.request";
        state.alumniWorkspace.draft = payload.data || null;
        state.alumniWorkspace.status = "review";
        state.alumniWorkspace.agentReviewed = true;
        state.alumniWorkspace.sendStatus = "idle";
        state.alumniWorkspace.sendError = null;
        state.alumniWorkspace.requestId = payload.requestId;
      }
      if (header === "alumni:resume-share-review") {
        state.latestUiTarget = "alumni.resume-share";
        state.alumniWorkspace.resumeShareDraft = payload.data || null;
        state.alumniWorkspace.resumeShareReviewed = true;
        state.alumniWorkspace.resumeShareStatus = "review";
        state.alumniWorkspace.resumeShareError = null;
        state.alumniWorkspace.requestId = payload.requestId;
      }
      if (header === "alumni_connect_completed") {
        state.alumniWorkspace = emptyAlumniWorkspace();
      }

      // ── Interview ──
      if (header === "button:options" && payload.data?.type === "options") {
        state.latestUiTarget = "student.mock-interview";
        state.interviewWorkspace = {
          ...emptyInterviewWorkspace(),
          status: "choosing",
          options: Array.isArray(payload.data.options) ? payload.data.options : [],
          requestId: payload.requestId,
        };
      }
      if (header === "select:job:db") {
        state.latestUiTarget = "student.mock-interview";
        state.interviewWorkspace.status = "awaiting-job";
        state.interviewWorkspace.error = null;
        state.interviewWorkspace.requestId = payload.requestId;
        if (Array.isArray(payload.data?.jobs)) {
          state.interviewWorkspace.dbJobs = payload.data.jobs;
        }
      }
      if (header === "text:mode:interview") {
        state.latestUiTarget = "student.mock-interview";
        state.interviewWorkspace.requestId = payload.requestId;
        if (payload.data?.type === "interview_intro") {
          state.interviewWorkspace.status = "awaiting-name";
          state.interviewWorkspace.currentQuestion = "";
        } else if (payload.data?.type === "interview_question") {
          state.interviewWorkspace.status = "in-progress";
          state.interviewWorkspace.currentQuestion = payload.response || "";
          state.interviewWorkspace.questionNumber = payload.data.question_number || 0;
          state.interviewWorkspace.topic = payload.data.topic || "General";
          state.interviewWorkspace.secondsRemaining = payload.data.seconds_remaining || 0;
        } else if (payload.data?.type === "error") {
          state.interviewWorkspace.status = "error";
          state.interviewWorkspace.error = payload.response || FALLBACK_ERROR_TEXT;
        }
      }
      if (header === "interview:end" && payload.data?.type === "interview_report") {
        state.latestUiTarget = "student.mock-interview";
        state.interviewWorkspace.status = "complete";
        state.interviewWorkspace.report = payload.data.report || null;
        state.interviewWorkspace.reason = payload.data.reason || null;
        state.interviewWorkspace.currentQuestion = "";
        state.interviewWorkspace.requestId = payload.requestId;
        // Interview history is persisted per user by the store persister.
        if (payload.data.report && !state.interviewHistory.some((entry) => entry.id === payload.requestId)) {
          state.interviewHistory = [
            { id: payload.requestId || newId(), completedAt: payload.data.report?.generated_at || nowIso(), report: payload.data.report },
            ...state.interviewHistory,
          ].slice(0, MAX_INTERVIEW_HISTORY);
        }
      }

      // ── Gap Analysis workspace ──
      if (header === "mode:gapAnalysis:analysis" || header === "mode:gapAnalysis:suggestions") {
        state.latestUiTarget = "tpo.gap-analysis";
        state.gapAnalysisWorkspace.status = "ready";
        state.gapAnalysisWorkspace.requestId = payload.requestId;
        if (Array.isArray(payload.data?.gaps) && payload.data.gaps.length > 0) {
          state.gapAnalysisWorkspace.gaps = payload.data.gaps;
        }
        if (Array.isArray(payload.data?.suggestions) && payload.data.suggestions.length > 0) {
          state.gapAnalysisWorkspace.suggestions = payload.data.suggestions;
        }
        if (Number.isFinite(payload.confidence_score)) {
          state.gapAnalysisWorkspace.confidenceScore = payload.confidence_score;
        }
        state.gapAnalysisWorkspace.error = null;
      }
      if (header === "mode:gapAnalysis:error") {
        state.latestUiTarget = "tpo.gap-analysis";
        state.gapAnalysisWorkspace.status = "error";
        state.gapAnalysisWorkspace.error = payload.response || "Something went wrong.";
        state.gapAnalysisWorkspace.requestId = payload.requestId;
      }

      // ── Learning Recommendation workspace ──
      if (header === "select:interview:db") {
        state.latestUiTarget = "student.learning-recommendation";
        state.learningWorkspace.status = "select-interview";
        state.learningWorkspace.requestId = payload.requestId;
        state.learningWorkspace.error = null;
        if (Array.isArray(payload.data?.interviews)) {
          state.learningWorkspace.interviews = payload.data.interviews;
        }
      }
      if (header === "learning:recommendations") {
        state.latestUiTarget = "student.learning-recommendation";
        state.learningWorkspace.status = "complete";
        state.learningWorkspace.recommendations = payload.data || null;
        state.learningWorkspace.requestId = payload.requestId;
        state.learningWorkspace.error = null;
      }
      if (header === "learning:recommendations-error") {
        state.latestUiTarget = "student.learning-recommendation";
        state.learningWorkspace.status = "error";
        state.learningWorkspace.error = payload.response || "Unable to generate recommendations.";
        state.learningWorkspace.requestId = payload.requestId;
      }
    },

    interviewTranscriptUpdated(state, action) {
      const { requestId, text } = action.payload || {};
      if (!requestId || typeof text !== "string") return;
      const message = state.messages.find((item) => item.requestId === requestId && item.sender === "user");
      if (message) message.text = text.trim() || "🎙️ Listening…";
    },

    interviewResourcesUpdated(state, action) {
      state.interviewWorkspace.resources = action.payload || null;
    },

    /** payload: { requestId, message?, header? } — terminal failure; releases every busy workspace. */
    requestFailed(state, action) {
      const { requestId, message: errorMessage, header } = action.payload || {};
      const request = state.requests[requestId];
      if (!request) return;
      request.status = "failed";
      request.error = errorMessage || FALLBACK_ERROR_TEXT;
      const message = state.messages.find((item) => item.id === request.assistantMessageId);
      if (message) {
        message.text = request.error;
        message.headerMessage = typeof header === "string" && header ? header : "error";
        message.streaming = false;
        message.pending = null;
        if (Array.isArray(message.toolCalls)) message.toolCalls = interruptToolCalls(message.toolCalls);
      }
      if (request.modeName === "resume-generator") {
        state.resumeWorkspace.status = "error";
        state.resumeWorkspace.error = request.error;
      }
      if (request.modeName === "job-creation") {
        state.jobCreationWorkspace.status = "error";
        state.jobCreationWorkspace.error = request.error;
      }
      if (request.modeName === "pr_outreach" || request.modeName === "pr-outreach") {
        state.prOutreachWorkspace.status = "error";
        state.prOutreachWorkspace.error = request.error;
      }
      if (request.modeName === "alumni-connect" || request.modeName === "alumni_connect") {
        state.alumniWorkspace.status = "error";
        state.alumniWorkspace.sendError = request.error;
      }
      if (request.modeName === "ai-interviewer") {
        state.interviewWorkspace.status = "error";
        state.interviewWorkspace.error = request.error;
      }
      if (request.modeName === "gap-analysis") {
        state.gapAnalysisWorkspace.status = "error";
        state.gapAnalysisWorkspace.error = request.error;
      }
      if (request.modeName === "learning-recommendation") {
        state.learningWorkspace.status = "error";
        state.learningWorkspace.error = request.error;
      }
    },

    prOutreachDraftUpdated(state, action) {
      const changes = action.payload || {};
      for (const field of ["to", "subject", "body"]) {
        if (typeof changes[field] === "string") state.prOutreachWorkspace[field] = changes[field];
      }
      if (typeof changes.status === "string") {
        state.prOutreachWorkspace.status = changes.status;
      } else if (["review", "satisfied", "sent"].includes(state.prOutreachWorkspace.status)) {
        state.prOutreachWorkspace.status = "editing";
        state.prOutreachWorkspace.agentSatisfied = false;
        state.prOutreachWorkspace.sendStatus = "idle";
        state.prOutreachWorkspace.sentAt = null;
        state.prOutreachWorkspace.messageId = null;
      }
      state.prOutreachWorkspace.error = null;
      state.prOutreachWorkspace.sendError = null;
    },

    prOutreachSendStarted(state) {
      state.prOutreachWorkspace.sendStatus = "sending";
      state.prOutreachWorkspace.sendError = null;
    },

    prOutreachSendSucceeded(state, action) {
      state.prOutreachWorkspace.status = "sent";
      state.prOutreachWorkspace.sendStatus = "sent";
      state.prOutreachWorkspace.sendError = null;
      state.prOutreachWorkspace.sentAt = nowIso();
      state.prOutreachWorkspace.messageId = action.payload?.messageId || null;
    },

    prOutreachSendFailed(state, action) {
      state.prOutreachWorkspace.sendStatus = "error";
      state.prOutreachWorkspace.sendError = action.payload || "Unable to send mail";
    },

    journeyJobSelected(state, action) {
      state.journey.selectedJob = action.payload || null;
    },

    alumniSelectionStarted(state) {
      state.alumniWorkspace.draft = null;
      state.alumniWorkspace.status = "working";
      state.alumniWorkspace.agentReviewed = false;
      state.alumniWorkspace.sendStatus = "idle";
      state.alumniWorkspace.sendError = null;
    },

    alumniDraftUpdated(state, action) {
      if (!state.alumniWorkspace.draft) return;
      state.alumniWorkspace.draft = { ...state.alumniWorkspace.draft, ...(action.payload || {}) };
      state.alumniWorkspace.status = "editing";
      state.alumniWorkspace.agentReviewed = false;
      state.alumniWorkspace.sendStatus = "idle";
      state.alumniWorkspace.sendError = null;
    },

    alumniSendStarted(state) {
      state.alumniWorkspace.sendStatus = "sending";
      state.alumniWorkspace.sendError = null;
    },

    alumniSendSucceeded(state) {
      state.alumniWorkspace.status = "sent";
      state.alumniWorkspace.sendStatus = "sent";
      state.alumniWorkspace.sendError = null;
    },

    alumniSendFailed(state, action) {
      state.alumniWorkspace.sendStatus = "error";
      state.alumniWorkspace.sendError = action.payload || "Unable to send connection request";
    },

    alumniResumeShareDraftUpdated(state, action) {
      if (!state.alumniWorkspace.resumeShareDraft) return;
      state.alumniWorkspace.resumeShareDraft = {
        ...state.alumniWorkspace.resumeShareDraft,
        ...(action.payload || {}),
      };
      state.alumniWorkspace.resumeShareReviewed = false;
      state.alumniWorkspace.resumeShareStatus = "editing";
      state.alumniWorkspace.resumeShareError = null;
    },

    alumniResumeShareStarted(state) {
      state.alumniWorkspace.resumeShareStatus = "sharing";
      state.alumniWorkspace.resumeShareError = null;
    },

    alumniResumeShareSucceeded(state) {
      state.alumniWorkspace.resumeShareStatus = "shared";
      state.alumniWorkspace.resumeShareError = null;
      state.alumniWorkspace.resumeShareDraft = null;
      state.alumniWorkspace.resumeShareReviewed = false;
    },

    alumniResumeShareFailed(state, action) {
      state.alumniWorkspace.resumeShareStatus = "error";
      state.alumniWorkspace.resumeShareError = action.payload || "Unable to share resume";
    },

    alumniResumeShareDismissed(state) {
      state.alumniWorkspace.resumeShareDraft = null;
      state.alumniWorkspace.resumeShareReviewed = false;
      state.alumniWorkspace.resumeShareStatus = "idle";
      state.alumniWorkspace.resumeShareError = null;
    },

    /** Archives the current chat and starts a fresh persisted session (name string or `{name, role}`). */
    newChatStarted: {
      reducer(state, action) {
        archiveCurrentSession(state);
        state.sessionId = action.payload.sessionId;
        state.messages = [buildWelcomeMessage(action.payload)];
        resetTransientWorkspaces(state);
        state.prOutreachWorkspace = emptyPROutreachWorkspace();
        state.alumniWorkspace = emptyAlumniWorkspace();
        state.interviewWorkspace = emptyInterviewWorkspace();
        state.journey = emptyJourney();
      },
      prepare: prepareWelcome,
    },

    conversationOpened(state, action) {
      const targetSessionId = action.payload;
      if (!targetSessionId || targetSessionId === state.sessionId) return;
      const target = state.sessions.find((session) => session.sessionId === targetSessionId);
      if (!target) return;

      archiveCurrentSession(state);
      state.sessions = state.sessions.filter((session) => session.sessionId !== targetSessionId);
      state.sessionId = target.sessionId;
      state.messages = normalizeMessages(target.messages);
      resetTransientWorkspaces(state);
      state.prOutreachWorkspace = { ...emptyPROutreachWorkspace(), ...(target.prOutreachWorkspace || {}) };
      state.alumniWorkspace = { ...emptyAlumniWorkspace(), ...(target.alumniWorkspace || {}) };
      state.interviewWorkspace = { ...emptyInterviewWorkspace(), ...(target.interviewWorkspace || {}) };
      state.journey = { ...emptyJourney(), ...(target.journey || {}) };
    },

    resetAIChat: {
      reducer(state, action) {
        state.sessionId = action.payload.sessionId;
        state.messages = [];
        state.sessions = [];
        resetTransientWorkspaces(state);
        state.prOutreachWorkspace = emptyPROutreachWorkspace();
        state.alumniWorkspace = emptyAlumniWorkspace();
        state.interviewWorkspace = emptyInterviewWorkspace();
        state.interviewHistory = [];
        state.journey = emptyJourney();
      },
      prepare() {
        return { payload: { sessionId: newId() } };
      },
    },

    setLearningSelectedInterview(state, action) {
      state.learningWorkspace.selectedInterview = action.payload || null;
    },

    resetLearningWorkspace(state) {
      state.learningWorkspace = emptyLearningWorkspace();
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(sessionStarted, (state, action) => {
        hydrateConversation(state, action.payload?.conversation || {});
        state.interviewHistory = Array.isArray(action.payload?.conversation?.interviewHistory)
          ? action.payload.conversation.interviewHistory.slice(0, MAX_INTERVIEW_HISTORY)
          : [];
      })
      .addCase(sessionEnded, (state, action) => {
        state.sessionId = action.payload?.chatSessionId || newId();
        state.messages = [];
        state.sessions = [];
        resetTransientWorkspaces(state);
        state.prOutreachWorkspace = emptyPROutreachWorkspace();
        state.alumniWorkspace = emptyAlumniWorkspace();
        state.interviewWorkspace = emptyInterviewWorkspace();
        state.interviewHistory = [];
        state.journey = emptyJourney();
      });
  },
});

// ─── Exports ──────────────────────────────────────────────────────────────────

export const {
  connectionChanged,
  conversationHydrated,
  ensureWelcomeMessage,
  requestStarted,
  responseReceived,
  interviewTranscriptUpdated,
  interviewResourcesUpdated,
  requestFailed,
  prOutreachDraftUpdated,
  prOutreachSendStarted,
  prOutreachSendSucceeded,
  prOutreachSendFailed,
  journeyJobSelected,
  alumniSelectionStarted,
  alumniDraftUpdated,
  alumniSendStarted,
  alumniSendSucceeded,
  alumniSendFailed,
  alumniResumeShareDraftUpdated,
  alumniResumeShareStarted,
  alumniResumeShareSucceeded,
  alumniResumeShareFailed,
  alumniResumeShareDismissed,
  setLearningSelectedInterview,
  resetLearningWorkspace,
  newChatStarted,
  conversationOpened,
  resetAIChat,
} = aiChatSlice.actions;

// ─── Selectors ────────────────────────────────────────────────────────────────

export const selectChatMessages = (state) => state.aiChat.messages;
export const selectAIConnected = (state) => state.aiChat.connected;
export const selectAILoading = (state) =>
  Object.values(state.aiChat.requests).some((request) => request.status === "pending" || request.status === "streaming");
export const selectLatestJobs = (state) => state.aiChat.latestJobs;
export const selectLatestUiTarget = (state) => state.aiChat.latestUiTarget;
export const selectResumeWorkspace = (state) => state.aiChat.resumeWorkspace;
export const selectJobCreationWorkspace = (state) => state.aiChat.jobCreationWorkspace;
export const selectPROutreachWorkspace = (state) => state.aiChat.prOutreachWorkspace;
export const selectAlumniWorkspace = (state) => state.aiChat.alumniWorkspace;
export const selectInterviewWorkspace = (state) => state.aiChat.interviewWorkspace;
export const selectGapAnalysisWorkspace = (state) => state.aiChat.gapAnalysisWorkspace;
export const selectLearningWorkspace = (state) => state.aiChat.learningWorkspace;
export const selectInterviewHistory = (state) => state.aiChat.interviewHistory;
export const selectStudentJourney = (state) => state.aiChat.journey;

export const selectChatSessions = createSelector(
  [
    (state) => state.aiChat.sessionId,
    (state) => state.aiChat.messages,
    (state) => state.aiChat.sessions,
    (state) => state.aiChat.prOutreachWorkspace,
    (state) => state.aiChat.alumniWorkspace,
    (state) => state.aiChat.interviewWorkspace,
    (state) => state.aiChat.journey,
  ],
  (sessionId, messages, sessions, prOutreachWorkspace, alumniWorkspace, interviewWorkspace, journey) => {
    const current = toSessionRecord({ sessionId, messages, prOutreachWorkspace, alumniWorkspace, interviewWorkspace, journey });
    const list = current ? [current, ...sessions.filter((session) => session.sessionId !== current.sessionId)] : sessions;
    return list.slice(0, MAX_ARCHIVED_SESSIONS + 1);
  },
);

export default aiChatSlice.reducer;
