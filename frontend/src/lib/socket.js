// The single shared Socket.IO connection (AI chat, notifications, attendance).
//
// The server resolves the user once per connection from `auth.token`, so the
// socket must reconnect whenever the access token changes (login, refresh,
// logout). Anonymous sockets are useless here (the chat and every realtime
// feature require a session), so without a token the socket stays
// disconnected — a logged-out shared phone never keeps receiving the previous
// user's `user:<id>` room events.
import { io } from "socket.io-client";
import { API_ORIGIN } from "./config.js";
import { getItem } from "./storage.js";

// Same origin as the app unless VITE_API_BASE_URL points at a separate API host.
const SOCKET_URL = API_ORIGIN || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
const hasDocument = typeof document !== "undefined";
const currentToken = () => getItem("token") || null;

export const socket = io(SOCKET_URL, {
  // Node tests have no document: never open a connection there.
  autoConnect: hasDocument && Boolean(currentToken()),
  auth: { token: currentToken() },
});

/** Drop the connection and forget the credentials (logout, revoked session). */
export const disconnectSocket = () => {
  socket.auth = { token: null };
  if (socket.connected || socket.active) socket.disconnect();
};

/** (Re)connect with the current access token; disconnect when signed out. */
export const ensureSocketAuthentication = () => {
  const token = currentToken();
  if (!token) {
    disconnectSocket();
    return;
  }
  if (socket.auth?.token === token && (socket.connected || socket.active)) return;
  socket.auth = { token };
  if (!hasDocument) return;
  if (socket.connected) socket.disconnect();
  socket.connect();
};
