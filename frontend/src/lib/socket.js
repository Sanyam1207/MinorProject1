import { io } from "socket.io-client";
import { API_ORIGIN } from "./api";

// Same origin as the app unless VITE_API_BASE_URL points at a separate API host.
const SOCKET_URL = API_ORIGIN || window.location.origin;

export const socket = io(SOCKET_URL, {
  autoConnect: true,
  auth: { token: localStorage.getItem("token") || null },
});

export const ensureSocketAuthentication = () => {
  const token = localStorage.getItem("token") || null;
  if (socket.auth?.token === token) return;

  socket.auth = { token };
  if (socket.connected) socket.disconnect();
  socket.connect();
};
