// Session state (FRONTEND.md §6.1), mounted as `state.session`.
//
// `sessionStarted` / `sessionRestored` / `sessionEnded` are also handled by the
// appContext, aiChat and notifications slices (extraReducers), so one dispatch
// produces one consistent state — the chat persister can never write one
// user's chat under another user's key.
import { createSlice } from "@reduxjs/toolkit";
import { getItem } from "../../lib/storage.js";

const initialState = () => ({
  status: getItem("token") ? "checking" : "anonymous",
  isModeChosen: getItem("isModeChosen") === "true",
  offline: false,
  endedReason: null,
});

const sessionSlice = createSlice({
  name: "session",
  initialState,
  reducers: {
    /** payload: { user, conversation, initialMode, isModeChosen } */
    sessionStarted(state, action) {
      state.status = "authenticated";
      state.isModeChosen = Boolean(action.payload?.isModeChosen);
      state.offline = false;
      state.endedReason = null;
    },
    /** payload: { user, offline? } — boot with a stored token. */
    sessionRestored(state, action) {
      state.status = "authenticated";
      state.offline = Boolean(action.payload?.offline);
      state.endedReason = null;
    },
    sessionAnonymous(state) {
      state.status = "anonymous";
      state.isModeChosen = false;
      state.offline = false;
    },
    /** payload: { reason: "logout" | "expired" } (+ a fresh chat session id for the reset chat) */
    sessionEnded: {
      reducer(state, action) {
        state.status = "anonymous";
        state.isModeChosen = false;
        state.offline = false;
        state.endedReason = action.payload?.reason === "expired" ? "expired" : "logout";
      },
      prepare(payload = {}) {
        return {
          payload: {
            reason: payload?.reason === "expired" ? "expired" : "logout",
            chatSessionId: globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}`,
          },
        };
      },
    },
    modeChosen(state) {
      state.isModeChosen = true;
    },
    noticeCleared(state) {
      state.endedReason = null;
    },
  },
});

export const { sessionStarted, sessionRestored, sessionAnonymous, sessionEnded, modeChosen, noticeCleared } =
  sessionSlice.actions;

export const selectSessionStatus = (state) => state.session.status;
export const selectIsModeChosen = (state) => state.session.isModeChosen;
export const selectSessionOffline = (state) => state.session.offline;
export const selectSessionEndedReason = (state) => state.session.endedReason;

export default sessionSlice.reducer;
