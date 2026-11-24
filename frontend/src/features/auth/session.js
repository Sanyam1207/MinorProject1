// Session thunks (FRONTEND.md §6.2).
import { getMe, logoutRequest } from "../../lib/api/auth.js";
import { ensureSocketAuthentication, disconnectSocket } from "../../lib/socket.js";
import { getItem, getJSON, removeItem, setItem, setJSON } from "../../lib/storage.js";
import { conversationHydrated, ensureWelcomeMessage, readConversationForUser } from "../../store/aiChatSlice.js";
import { setUserContext } from "../../store/appContextSlice.js";
import { toastError } from "../../ui/toast.js";
import { defaultModeFor, needsModeChoice } from "../../workspace/modes.js";
import { disablePush, fetchUnreadCount, syncPushState } from "../notifications/thunks.js";
import { sessionAnonymous, sessionEnded, sessionRestored, sessionStarted } from "./sessionSlice.js";

const SESSION_KEYS = ["token", "user", "isAuthenticated", "isModeChosen", "activeMode"];
const sameUser = (a, b) => Boolean(a && b) && String(a._id ?? a.id ?? a.email) === String(b._id ?? b.id ?? b.email);

const afterAuthenticated = (dispatch) => {
  ensureSocketAuthentication();
  dispatch(fetchUnreadCount());
  dispatch(syncPushState());
};

/** Boot: validate the stored token (http refreshes once on 401). */
export const bootstrapSession = () => async (dispatch, getState) => {
  if (!getItem("token")) {
    dispatch(sessionAnonymous());
    return null;
  }
  const cachedUser = getJSON("user");
  try {
    const user = await getMe();
    setJSON("user", user);
    if (cachedUser && !sameUser(cachedUser, user)) dispatch(conversationHydrated(readConversationForUser(user)));
    dispatch(sessionRestored({ user }));
    if (getState().aiChat.messages.length === 0) dispatch(ensureWelcomeMessage({ name: user?.name, role: user?.role }));
    afterAuthenticated(dispatch);
    return user;
  } catch (error) {
    if (error?.status === 401) {
      await dispatch(logout({ reason: "expired" }));
      return null;
    }
    // Offline / server down: keep working with the cached profile.
    if (cachedUser) {
      dispatch(sessionRestored({ user: cachedUser, offline: true }));
      ensureSocketAuthentication();
      return cachedUser;
    }
    dispatch(sessionAnonymous());
    return null;
  }
};

/** Successful sign-in (password or Google). Throws when the server response is incomplete. */
export const completeLogin = ({ user, accessToken } = {}) => async (dispatch) => {
  if (!user || !accessToken) throw new Error("The sign-in response was incomplete. Please try again.");
  const isModeChosen = !needsModeChoice(user.role);
  const initialMode = defaultModeFor(user.role);
  setItem("token", accessToken);
  setJSON("user", user);
  setItem("isAuthenticated", "true");
  setItem("isModeChosen", String(isModeChosen));
  setItem("activeMode", initialMode);
  dispatch(sessionStarted({ user, conversation: readConversationForUser(user), initialMode, isModeChosen }));
  dispatch(ensureWelcomeMessage({ name: user.name, role: user.role }));
  afterAuthenticated(dispatch);
  return user;
};

let logoutInFlight = null;

/**
 * Sign out (FRONTEND.md §6.2): stop push on this device, revoke the session
 * cookie, clear per-user storage + Redux state (one `sessionEnded`), and drop
 * the socket so this browser leaves the user's realtime rooms. Idempotent —
 * concurrent calls (e.g. `auth:expired` fired by the logout request itself)
 * share one run.
 */
export const logout = ({ reason = "logout", message } = {}) => (dispatch) => {
  if (logoutInFlight) return logoutInFlight;
  logoutInFlight = (async () => {
    const expired = reason === "expired";
    try {
      // An expired session cannot call authenticated endpoints; just drop the local subscription.
      await dispatch(disablePush({ notifyServer: !expired }));
    } catch {
      // best effort
    }
    if (expired) removeItem("token"); // no refresh attempts for the logout call itself
    try {
      await logoutRequest();
    } catch {
      // best effort: cookies may already be gone
    }
    for (const key of SESSION_KEYS) removeItem(key);
    dispatch(sessionEnded({ reason }));
    disconnectSocket();
    if (expired) toastError(message || "Your session expired. Please sign in again.");
  })().finally(() => {
    logoutInFlight = null;
  });
  return logoutInFlight;
};

/** Re-read the user from the server (profile edits, Gmail connect, GGSIPU sync). */
export const refreshCurrentUser = () => async (dispatch) => {
  const user = await getMe();
  dispatch(userUpdated(user));
  return user;
};

/** Store an updated user object (profile save, password change). */
export const userUpdated = (user) => (dispatch) => {
  if (!user) return;
  setJSON("user", user);
  dispatch(setUserContext(user));
};
