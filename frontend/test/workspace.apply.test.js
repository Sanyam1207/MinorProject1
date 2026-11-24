// UI-ACTIONS.md §12 scenarios 2–10 — applyUiActions semantics.
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/store.js";
import { createUiActionApplier } from "../src/workspace/uiActions.js";
import { panelParamsUpdated } from "../src/store/appContextSlice.js";
import { sanitizeParams } from "../src/workspace/panels.js";

const setup = (role) => {
  const store = createTestStore(role);
  const apply = createUiActionApplier({ getState: store.getState, dispatch: store.dispatch });
  const ctx = () => store.getState().appContext;
  return { store, apply, ctx };
};

const TAILOR = { id: "a1", panel: "resume.lab", params: { tab: "tailor", resumeId: "r1", jobId: "j1", junk: 1 } };

test("2. copilot resume.lab action lands on the tailor tool with sanitized params", () => {
  const { apply, ctx } = setup("student");
  const result = apply([TAILOR], { source: "copilot", requestId: "q1" });
  assert.deepEqual(result.applied, [{ id: "q1:a1", panel: "resume.lab" }]);
  assert.equal(ctx().activeMode, "resume");
  assert.equal(ctx().activeResumeTool, "tailor");
  assert.deepEqual(ctx().panelParams["resume.lab"], { tab: "tailor", resumeId: "r1", jobId: "j1" });
  assert.equal(ctx().panelNonce["resume.lab"], 1);
});

test("3. copilot actions are deduped per request", () => {
  const { apply, ctx } = setup("student");
  apply([TAILOR], { source: "copilot", requestId: "q1" });
  const again = apply([TAILOR], { source: "copilot", requestId: "q1" });
  assert.equal(again.applied.length, 0);
  assert.equal(again.skipped[0].reason, "DUPLICATE");
  const next = apply([TAILOR], { source: "copilot", requestId: "q2" });
  assert.equal(next.applied.length, 1);
  assert.equal(ctx().panelNonce["resume.lab"], 2);
});

test("4. role checks: student cannot open tpo.offers; tpo is redirected from offers", () => {
  const student = setup("student");
  const before = student.ctx();
  const denied = student.apply([{ panel: "tpo.offers" }], { source: "copilot", requestId: "q1" });
  assert.equal(denied.skipped[0].reason, "FORBIDDEN");
  assert.equal(student.ctx(), before, "state unchanged");

  const tpo = setup("tpo");
  tpo.apply([{ panel: "offers" }], { source: "copilot", requestId: "q1" });
  assert.equal(tpo.ctx().activeMode, "tpo");
  assert.equal(tpo.ctx().activeFeature, "offer-management");
  assert.equal(tpo.ctx().activePanel, "tpo.offers");
});

test("5. teacher schedule alias re-sanitizes against teacher.schedule", () => {
  const { apply, ctx } = setup("teacher");
  apply([{ panel: "schedule", params: { days: "3" } }], { source: "copilot", requestId: "q1" });
  assert.equal(ctx().activePanel, "teacher.schedule");
  assert.deepEqual(ctx().panelParams["teacher.schedule"], { view: "list" });
});

test("6. required params", () => {
  const { apply } = setup("student");
  assert.equal(apply([{ panel: "jobs.detail" }], { source: "copilot", requestId: "q1" }).skipped[0].reason, "MISSING_PARAM");
  assert.equal(
    apply([{ id: "b", panel: "jobs.detail", params: { jobId: "x y" } }], { source: "copilot", requestId: "q1" }).skipped[0].reason,
    "MISSING_PARAM",
  );
});

test("7. overlays keep the mode; a workspace panel closes the overlay", () => {
  const { apply, ctx } = setup("student");
  const mode = ctx().activeMode;
  apply([{ panel: "notifications", params: { tab: "preferences" } }], { source: "user" });
  assert.equal(ctx().overlay, "notifications");
  assert.equal(ctx().activeMode, mode);
  assert.deepEqual(ctx().panelParams.notifications, { tab: "preferences" });
  apply([{ panel: "student.home" }], { source: "user" });
  assert.equal(ctx().overlay, null);
});

test("8. batches apply in order and store every panel's params", () => {
  const { apply, ctx } = setup("student");
  apply([{ id: "1", panel: "schedule" }, { id: "2", panel: "attendance.scan" }], { source: "copilot", requestId: "q1" });
  assert.equal(ctx().activePanel, "attendance.scan");
  assert.deepEqual(ctx().panelParams.schedule, { days: 7 });
  assert.deepEqual(ctx().panelParams["attendance.scan"], {});
});

test("9. one-shot data is stored, and dropped by a later action without data", () => {
  const { apply, ctx } = setup("student");
  apply([{ id: "1", panel: "resume.lab", params: { tab: "tailor" }, data: { patches: [1] } }], { source: "copilot", requestId: "q1" });
  assert.deepEqual(ctx().panelData["resume.lab"], { patches: [1] });
  apply([{ id: "2", panel: "resume.lab", params: { tab: "tailor" } }], { source: "copilot", requestId: "q1" });
  assert.equal("resume.lab" in ctx().panelData, false);
});

test("10. user navigation keeps params; copilot replaces them; aliases sanitize", () => {
  const { store, apply, ctx } = setup("student");
  apply([{ panel: "jobs.market", params: {} }], { source: "user" });
  store.dispatch(panelParamsUpdated({ panelId: "jobs.market", params: sanitizeParams("jobs.market", { query: "react" }).params, replace: true }));
  apply([{ panel: "jobs.market" }], { source: "user" });
  assert.deepEqual(ctx().panelParams["jobs.market"], { query: "react" });

  apply([{ id: "c", panel: "jobs.market" }], { source: "copilot", requestId: "q1" });
  assert.deepEqual(ctx().panelParams["jobs.market"], {});

  apply([{ id: "d", panel: "jobs.market", params: { q: "sql", highlightIds: "a1,b2,bad id" } }], { source: "copilot", requestId: "q1" });
  assert.deepEqual(ctx().panelParams["jobs.market"], { query: "sql", highlightIds: ["a1", "b2"] });

  const tpo = setup("tpo");
  tpo.apply([{ panel: "tpo.jobfeed", params: { runId: "r9" } }], { source: "notification" });
  assert.equal(tpo.ctx().activePanel, "tpo.job-feed");
  assert.deepEqual(tpo.ctx().panelParams["tpo.job-feed"], { runId: "r9" });
});

test("copilot/header actions flag the workspace on phones instead of switching panes", () => {
  const { store, apply, ctx } = setup("student");
  store.dispatch({ type: "appContext/mobilePaneChanged", payload: "chat" });
  apply([{ id: "1", panel: "jobs.matched" }], { source: "copilot", requestId: "q1" });
  assert.equal(ctx().mobilePane, "chat");
  assert.equal(ctx().workspaceAttention, true);
  apply([{ panel: "student.home" }], { source: "user" });
  assert.equal(ctx().mobilePane, "workspace");
  assert.equal(ctx().workspaceAttention, false);
});

test("a workspace action marks the mode as chosen (deep links skip the welcome screen)", () => {
  const { store, apply } = setup("student");
  store.dispatch({ type: "session/sessionAnonymous" });
  store.dispatch({ type: "session/sessionRestored", payload: { user: { _id: "u", role: "student" } } });
  assert.equal(store.getState().session.isModeChosen, false);
  apply([{ panel: "attendance.scan" }], { source: "deeplink" });
  assert.equal(store.getState().session.isModeChosen, true);
});
