// FRONTEND.md §18 shell tests (1)–(5): agent modes, copilot chunks, terminal failures, hydration, role modes.
import "./helpers/env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { configureStore } from "@reduxjs/toolkit";
import { createTestStore, testUser } from "./helpers/store.js";
import { AGENT_MODE_BY_HEADER, agentModeForMessages } from "../src/workspace/agentModes.js";
import aiChat, {
  chatHistoryKey,
  conversationHydrated,
  readConversationForUser,
  requestFailed,
  requestStarted,
  responseReceived,
} from "../src/store/aiChatSlice.js";
import { allowedModesFor, defaultModeFor, isModeAllowed, needsModeChoice } from "../src/workspace/modes.js";

// The map as it was before the merge (src/services/aiRequestHandler.js) — every entry must keep its agent mode.
const LEGACY_AGENT_MODES = {
  "mode:switch:jobs": "jobs-finder",
  "mode:switch:resume": "resume-generator",
  "mode:switch:job-eligibility": "job-eligibility",
  "mode:switch:job-creation": "job-creation",
  "mode:jobparser:jobslist": "jobs-finder",
  "mode:jobparser:eligibility": "job-eligibility",
  resume_generator: "resume-generator",
  "resume-generator": "resume-generator",
  "mode:jobCreation:data": "job-creation",
  "mode:jobCreation:ready": "job-creation",
  "mode:jobCreation:post": "job-creation",
  "mode:jobCreation:error": "job-creation",
  "mode:switch:pr-outreach": "pr_outreach",
  "mail:review": "pr_outreach",
  pr_outreach_satisfied: "pr_outreach",
  pr_outreach_completed: "pr_outreach",
  "mode:switch:alumni-connect": "alumni-connect",
  alumni_connect: "alumni-connect",
  "alumni:matches": "alumni-connect",
  "alumni:request-review": "alumni-connect",
  "alumni:resume-share-review": "alumni-connect",
  alumni_connect_completed: "alumni-connect",
  "mode:switch:ai-interviewer": "ai-interviewer",
  "button:options": "ai-interviewer",
  "select:job:db": "ai-interviewer",
  "text:mode:interview": "ai-interviewer",
  "interview:end": "ai-interviewer",
  "mode:switch:gap-analysis": "gap-analysis",
  "mode:gapAnalysis:analysis": "gap-analysis",
  "mode:gapAnalysis:suggestions": "gap-analysis",
  "mode:gapAnalysis:error": "gap-analysis",
  "mode:switch:learning-recommendation": "learning-recommendation",
  "select:interview:db": "learning-recommendation",
  "learning:recommendations": "learning-recommendation",
  "learning:recommendations-error": "learning-recommendation",
};

test("(1) copilot headers map to the copilot; every legacy header keeps its agent mode", () => {
  for (const header of ["copilot:thinking", "copilot:tool", "copilot:answer", "copilot:confirm", "copilot:error", "mode:switch:copilot"]) {
    assert.equal(AGENT_MODE_BY_HEADER[header], "copilot", header);
  }
  for (const [header, mode] of Object.entries(LEGACY_AGENT_MODES)) assert.equal(AGENT_MODE_BY_HEADER[header], mode, header);
});

const startRequest = (store, requestId, modeName = "copilot") =>
  store.dispatch(
    requestStarted({
      requestId,
      userMessageId: `${requestId}-u`,
      assistantMessageId: `${requestId}-a`,
      text: "Schedule DBMS tomorrow at 10am",
      createdAt: "2026-11-25T09:00:00.000Z",
      payload: { mode_name: modeName, source: "chat" },
    }),
  );
const botMessage = (store, requestId) => store.getState().aiChat.messages.find((message) => message.id === `${requestId}-a`);

test("(2) copilot chunks set toolCalls, pending and options; requestFailed interrupts running tools", () => {
  const store = createTestStore("teacher");
  startRequest(store, "q1");
  store.dispatch(
    responseReceived({
      requestId: "q1",
      header_message: "copilot:tool",
      response: "Looking up your courses…",
      isEnd: false,
      data: {
        type: "copilot",
        phase: "tool",
        tool_calls: [{ id: "c1", name: "attendance_list_courses", args: {}, status: "running" }],
        ui_actions: [{ id: "c1:0", panel: "teacher.courses", params: {}, data: { big: true } }],
      },
    }),
  );
  let message = botMessage(store, "q1");
  assert.equal(message.toolCalls[0].status, "running");
  assert.deepEqual(message.uiActions, [{ id: "c1:0", panel: "teacher.courses", params: {} }], "ui action data is not stored on the message");
  assert.equal(message.streaming, true);

  store.dispatch(
    responseReceived({
      requestId: "q1",
      header_message: "copilot:confirm",
      response: "Schedule CS301 · Tue 25 Nov, 10:00–11:00?",
      isEnd: true,
      options: ["Confirm", "Cancel"],
      data: {
        type: "copilot",
        phase: "answer",
        tool_calls: [
          { id: "c1", name: "attendance_list_courses", args: {}, status: "done", summary: "2 courses" },
          { id: "c2", name: "attendance_schedule_class", args: { course: "dbms" }, status: "needs_confirmation" },
        ],
        ui_actions: [{ id: "c1:0", panel: "teacher.courses", params: {} }],
        pending: { tool: "attendance_schedule_class", args: { course: "dbms" }, preview: "Schedule CS301 · Tue 25 Nov, 10:00–11:00?" },
      },
    }),
  );
  message = botMessage(store, "q1");
  assert.equal(message.toolCalls.length, 2);
  assert.equal(message.toolCalls[1].status, "needs_confirmation");
  assert.equal(message.pending.tool, "attendance_schedule_class");
  assert.deepEqual(message.options, ["Confirm", "Cancel"]);
  assert.equal(message.headerMessage, "copilot:confirm");
  assert.equal(message.streaming, false);
  assert.equal(store.getState().aiChat.latestUiTarget, "copilot");

  startRequest(store, "q2");
  store.dispatch(
    responseReceived({
      requestId: "q2",
      header_message: "copilot:tool",
      response: "",
      isEnd: false,
      data: { tool_calls: [{ id: "x", name: "attendance_start_session", status: "running" }], ui_actions: [] },
    }),
  );
  store.dispatch(requestFailed({ requestId: "q2", message: "The AI service stopped responding." }));
  const failed = botMessage(store, "q2");
  assert.deepEqual(
    { status: failed.toolCalls[0].status, error: failed.toolCalls[0].error },
    { status: "error", error: "Interrupted" },
  );
  assert.equal(failed.streaming, false);
  assert.equal(failed.text, "The AI service stopped responding.");
});

test("(3) 'AI backend timeout' (isEnd, data.type error) on a job-creation request leaves the workspace in error", async () => {
  const { aiRequestHandler } = await import("../src/services/aiRequestHandler.js");
  const store = createTestStore("tpo");
  aiRequestHandler.initialize(store);
  after(() => aiRequestHandler.clearAllTimeouts());

  const sent = aiRequestHandler.send({ text: "Create a job for Acme", modeName: "job-creation", feature: "job-creation" });
  assert.equal(store.getState().aiChat.jobCreationWorkspace.status, "collecting");
  aiRequestHandler.handleResponse({
    requestId: sent.requestId,
    header_message: "AI backend timeout",
    response: "The assistant took too long to respond. Please try again.",
    data: { type: "error" },
    isEnd: true,
  });
  const state = store.getState().aiChat;
  assert.equal(state.jobCreationWorkspace.status, "error");
  assert.equal(state.jobCreationWorkspace.error, "The assistant took too long to respond. Please try again.");
  assert.equal(state.requests[sent.requestId].status, "failed");
  aiRequestHandler.clearAllTimeouts();
});

test("query payload carries details.ui_context and the teacher copilot fallback", async () => {
  const { aiRequestHandler } = await import("../src/services/aiRequestHandler.js");
  const { socket } = await import("../src/lib/socket.js");
  const store = createTestStore("teacher");
  aiRequestHandler.store = store; // re-point the singleton at this store
  const sent = aiRequestHandler.send({ text: "Who is below 75%?" });
  assert.equal(store.getState().aiChat.requests[sent.requestId].modeName, "copilot");
  // The socket is offline under node, so the packet waits in the send buffer.
  const packet = socket.sendBuffer.map((entry) => entry.data).find(([event, body]) => event === "query" && body.requestId === sent.requestId);
  assert.ok(packet, "query emitted");
  assert.equal(packet[1].mode_name, "copilot");
  assert.deepEqual(packet[1].details.ui_context, { mode: "teacher", panel: "teacher.home", params: {} });
  aiRequestHandler.clearAllTimeouts();
});

test("(4) stored streaming messages hydrate as not streaming; running tools become interrupted", () => {
  const user = testUser("student");
  localStorage.setItem(
    chatHistoryKey(user._id),
    JSON.stringify({
      sessionId: "s-1",
      messages: [
        { id: "m1", sender: "user", text: "hi", streaming: false },
        { id: "m2", sender: "bot", text: "", streaming: true, headerMessage: "copilot:tool", toolCalls: [{ id: "t", name: "x", status: "running" }] },
      ],
      sessions: [{ sessionId: "s-0", messages: [{ id: "m0", sender: "bot", text: "old", streaming: true }] }],
    }),
  );
  const conversation = readConversationForUser(user);
  assert.equal(conversation.messages[1].streaming, false);
  assert.equal(conversation.messages[1].toolCalls[0].status, "error");
  assert.equal(conversation.sessions[0].messages[0].streaming, false);
  assert.equal(agentModeForMessages(conversation.messages), "copilot");

  const store = configureStore({ reducer: { aiChat } });
  store.dispatch(conversationHydrated({ messages: [{ id: "x", sender: "bot", text: "t", streaming: true }] }));
  assert.equal(store.getState().aiChat.messages[0].streaming, false);
  localStorage.clear();
});

test("(5) role → modes for all six roles and an unknown role", () => {
  const expected = {
    student: [["student", "resume", "pr_outreach", "alumni_connect"], "student", true],
    teacher: [["teacher"], "teacher", false],
    tpo: [["tpo", "pr_outreach"], "tpo", false],
    admin: [["tpo", "pr_outreach"], "tpo", false],
    company: [["company"], "company", false],
    alumni: [["alumni"], "alumni", false],
    martian: [["student", "resume", "pr_outreach", "alumni_connect"], "student", true],
  };
  for (const [role, [modes, home, choose]] of Object.entries(expected)) {
    assert.deepEqual(allowedModesFor(role), modes, role);
    assert.equal(defaultModeFor(role), home, role);
    assert.equal(needsModeChoice(role), choose, role);
  }
  assert.equal(isModeAllowed("tpo", "student"), false);
  assert.equal(isModeAllowed("company", "company"), true);
});
