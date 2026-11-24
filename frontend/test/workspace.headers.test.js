// UI-ACTIONS.md §12 scenario 11 — legacy header routing is role-checked.
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/store.js";
import { createUiActionApplier } from "../src/workspace/uiActions.js";
import { copilotUiActions, routeHeader } from "../src/workspace/headerRoutes.js";

const JOB = { id: "6743f0c2a1b2c3d4e5f60711", kind: "campus", title: "Data Analyst Intern" };

test("11. jobslist: empty data → no action; a job → student lands on jobs.matched; TPO stays put", () => {
  assert.deepEqual(routeHeader({ requestId: "r1", header_message: "mode:jobparser:jobslist", data: [] }), []);

  const actions = routeHeader({ requestId: "r1", header_message: "mode:jobparser:jobslist", data: [JOB] });
  assert.deepEqual(actions, [{ panel: "jobs.matched", id: "hdr:r1:jobs.matched:" }]);

  const student = createTestStore("student");
  const applyStudent = createUiActionApplier({ getState: student.getState, dispatch: student.dispatch });
  applyStudent(actions, { source: "header", requestId: "r1" });
  assert.equal(student.getState().appContext.activePanel, "jobs.matched");
  assert.equal(student.getState().appContext.activeJobsTab, "matched");

  const tpo = createTestStore("tpo");
  const before = tpo.getState().appContext;
  const applyTpo = createUiActionApplier({ getState: tpo.getState, dispatch: tpo.dispatch });
  const result = applyTpo(actions, { source: "header", requestId: "r1" });
  assert.equal(result.skipped[0].reason, "FORBIDDEN");
  assert.equal(tpo.getState().appContext, before);
  assert.equal(tpo.getState().appContext.activeMode, "tpo");
});

test("header ids dedupe streaming chunks of the same request", () => {
  const store = createTestStore("student");
  const apply = createUiActionApplier({ getState: store.getState, dispatch: store.dispatch });
  const chunk = { requestId: "r2", header_message: "resume-generator", data: { type: "latex", content: "\\documentclass" } };
  assert.equal(apply(routeHeader(chunk), { source: "header", requestId: "r2" }).applied.length, 1);
  assert.equal(apply(routeHeader(chunk), { source: "header", requestId: "r2" }).skipped[0].reason, "DUPLICATE");
  const analysis = { requestId: "r2", header_message: "resume-generator", data: { type: "analysis", analysis_type: "gap" } };
  assert.deepEqual(routeHeader(analysis)[0].params, { tab: "skill-gap" });
});

test("wishlist ui passes through; mode switches and copilot headers produce no header actions", () => {
  const wishlist = {
    requestId: "r3",
    header_message: "mode:jobparser:addjob:wishlist",
    data: { type: "wishlist", ok: true, ui: { panel: "jobs.tracker", params: { status: "saved", highlightId: "j9" } } },
  };
  assert.deepEqual(routeHeader(wishlist), [{ panel: "jobs.tracker", params: { status: "saved", highlightId: "j9" }, id: "hdr:r3:jobs.tracker:" }]);
  assert.deepEqual(routeHeader({ requestId: "r3", header_message: "mode:switch:jobs" }), []);
  assert.deepEqual(routeHeader({ requestId: "r3", header_message: "mode:none" }), []);
  assert.deepEqual(routeHeader({ requestId: "r3", header_message: "copilot:tool", data: { ui_actions: [{ id: "x", panel: "schedule" }] } }), []);
  assert.deepEqual(copilotUiActions({ header_message: "copilot:tool", data: { ui_actions: [{ id: "x", panel: "schedule" }] } }), [{ id: "x", panel: "schedule" }]);
});
