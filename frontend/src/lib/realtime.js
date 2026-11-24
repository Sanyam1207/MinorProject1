// Realtime helpers on top of the single shared socket (lib/socket.js).
//
//   useSocketEvent("notification:new", (payload) => ...)
//   const ack = await emitWithAck("attendance:presenter:join", { sessionId })
//   useSocketConnected() -> boolean
//
// The socket re-authenticates whenever the access token changes
// (login, refresh), so components never manage auth themselves.
import { useEffect, useRef, useState } from "react";
import { ensureSocketAuthentication, socket } from "./socket.js";

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent(event, handler) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!event) return undefined;
    const listener = (...args) => handlerRef.current?.(...args);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [event]);
}

/** Emit and wait for the server acknowledgement (rejects after `timeoutMs`). */
export function emitWithAck(event, payload, timeoutMs = 8000) {
  ensureSocketAuthentication();
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(new Error("The server did not respond in time"));
      else resolve(response);
    });
  });
}

/** Re-run `callback` every time the socket (re)connects — e.g. to re-join rooms. */
export function useOnSocketConnect(callback) {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const listener = () => callbackRef.current?.();
    socket.on("connect", listener);
    if (socket.connected) listener();
    return () => {
      socket.off("connect", listener);
    };
  }, []);
}

export function useSocketConnected() {
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    socket.on("connect", on);
    socket.on("disconnect", off);
    return () => {
      socket.off("connect", on);
      socket.off("disconnect", off);
    };
  }, []);
  return connected;
}

// Keep the socket's credentials in sync with token refreshes performed by lib/http.js.
if (typeof window !== "undefined") {
  window.addEventListener("auth:token-refreshed", () => ensureSocketAuthentication());
}
