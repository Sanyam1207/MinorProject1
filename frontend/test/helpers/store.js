// Fresh Redux stores for tests (no persister, no window listeners).
import "./env.js";
import { configureStore } from "@reduxjs/toolkit";
import appContext from "../../src/store/appContextSlice.js";
import aiChat from "../../src/store/aiChatSlice.js";
import session, { sessionStarted } from "../../src/features/auth/sessionSlice.js";
import notifications from "../../src/features/notifications/notificationsSlice.js";

export const testUser = (role = "student") => ({
  _id: `user-${role}`,
  name: `Test ${role}`,
  email: `${role}@demo.edu`,
  role,
});

/** A store signed in as `role` with the mode already chosen. */
export function createTestStore(role = "student") {
  const store = configureStore({ reducer: { appContext, aiChat, session, notifications } });
  store.dispatch(sessionStarted({ user: testUser(role), conversation: { messages: [] }, isModeChosen: true }));
  return store;
}

/** Stub every request of the shared http client; returns the list of captured configs. */
export function stubHttp(http, respond) {
  const calls = [];
  const previous = http.defaults.adapter;
  http.defaults.adapter = async (config) => {
    calls.push(config);
    return respond(config);
  };
  return { calls, restore: () => (http.defaults.adapter = previous) };
}

export const envelope = (data, message = "ok") => ({ statusCode: 200, success: true, message, data });
export const okResponse = (config, data, message) => ({
  data: envelope(data, message),
  status: 200,
  statusText: "OK",
  headers: {},
  config,
});
