import { configureStore } from "@reduxjs/toolkit";
import { keysWithPrefix, removeItem, setItem, setJSON } from "../lib/storage.js";
import appContextReducer from "./appContextSlice.js";
import aiChatReducer, {
  CHAT_STORAGE_LEVELS,
  chatHistoryKey,
  chatIdentity,
  chatStorageSnapshot,
  interviewHistoryKey,
} from "./aiChatSlice.js";
import sessionReducer from "../features/auth/sessionSlice.js";
import notificationsReducer from "../features/notifications/notificationsSlice.js";

export const store = configureStore({
  reducer: {
    appContext: appContextReducer,
    aiChat: aiChatReducer,
    session: sessionReducer,
    notifications: notificationsReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: { warnAfter: 128 },
      immutableCheck: { warnAfter: 128 },
    }),
});

// ─── Chat persistence (quota-safe) ───────────────────────────────────────────
//
// - Writes only for an authenticated session, under that user's key, so a
//   guest or the next user never inherits a chat (sessionStarted/sessionEnded
//   switch identity in ONE dispatch; a pending snapshot of the previous user is
//   flushed under the previous user's key first).
// - Throttled (streaming responses dispatch many times per second) and flushed
//   on pagehide.
// - Never throws into dispatch: on QuotaExceededError other users' stale chat
//   histories are pruned, then the snapshot degrades (fewer archived sessions,
//   fewer messages, no LaTeX) and finally the key is dropped.
const PERSIST_INTERVAL_MS = 400;
const CHAT_PREFIX = chatHistoryKey("");

let pending = null; // { identity, aiChat }
let timer = null;
let lastRefs = null;
let lastIdentity = null;
let lastHistoryRef = null;
const lastWritten = new Map();

const chatRefs = (aiChat) => [
  aiChat.sessionId,
  aiChat.messages,
  aiChat.sessions,
  aiChat.prOutreachWorkspace,
  aiChat.alumniWorkspace,
  aiChat.journey,
];
const sameRefs = (a, b) => Boolean(a && b) && a.length === b.length && a.every((value, index) => value === b[index]);

const pruneOtherChatHistories = (identity) => {
  const keep = chatHistoryKey(identity);
  for (const key of keysWithPrefix(CHAT_PREFIX)) if (key !== keep) removeItem(key);
};

const writeChat = (identity, aiChat) => {
  const key = chatHistoryKey(identity);
  let pruned = false;
  for (let level = 0; level < CHAT_STORAGE_LEVELS; level += 1) {
    let serialized;
    try {
      serialized = JSON.stringify(chatStorageSnapshot(aiChat, level));
    } catch {
      return;
    }
    if (lastWritten.get(identity) === serialized) return;
    if (setItem(key, serialized)) {
      lastWritten.set(identity, serialized);
      return;
    }
    if (!pruned) {
      pruned = true;
      pruneOtherChatHistories(identity);
      if (setItem(key, serialized)) {
        lastWritten.set(identity, serialized);
        return;
      }
    }
  }
  removeItem(key);
  lastWritten.delete(identity);
};

const flush = () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending) return;
  const { identity, aiChat } = pending;
  pending = null;
  writeChat(identity, aiChat);
};

const schedule = () => {
  if (!timer) timer = setTimeout(flush, PERSIST_INTERVAL_MS);
};

const writeInterviewHistory = (identity, history) => {
  if (!Array.isArray(history)) return;
  if (!setJSON(interviewHistoryKey(identity), history.slice(0, 20))) {
    setJSON(interviewHistoryKey(identity), history.slice(0, 5));
  }
};

store.subscribe(() => {
  const state = store.getState();
  const identity = state.session.status === "authenticated" ? chatIdentity(state.appContext.user) : null;

  if (identity !== lastIdentity) {
    flush(); // the previous user's last snapshot goes under the previous user's key
    lastIdentity = identity;
    lastRefs = null;
    lastHistoryRef = state.aiChat.interviewHistory;
  }
  if (!identity) return;

  const refs = chatRefs(state.aiChat);
  if (!sameRefs(refs, lastRefs)) {
    lastRefs = refs;
    pending = { identity, aiChat: state.aiChat };
    schedule();
  }
  if (state.aiChat.interviewHistory !== lastHistoryRef) {
    lastHistoryRef = state.aiChat.interviewHistory;
    writeInterviewHistory(identity, state.aiChat.interviewHistory);
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}
