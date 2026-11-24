// UI-ACTIONS.md §12 scenario 12 — deep links.
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPanelUrl, isSameOriginUrl, parsePanelUrl, stripPanelParams } from "../src/workspace/deepLink.js";

test("12. parsePanelUrl", () => {
  assert.deepEqual(parsePanelUrl("?panel=teacher.live&params=%7B%22sessionId%22%3A%22s1%22%7D&nid=n1"), {
    panel: "teacher.live",
    params: { sessionId: "s1" },
    nid: "n1",
  });
  assert.deepEqual(parsePanelUrl("?panel=teacher.live&params=%7Bbad").params, {});
  assert.equal(parsePanelUrl("?params=%7B%7D"), null);
  assert.equal(parsePanelUrl(""), null);
});

test("12. buildPanelUrl round-trips", () => {
  const url = buildPanelUrl({ panel: "jobs.market", params: { query: "data analyst", highlightIds: ["a1", "b2"] } }, { origin: "https://campus.example.edu", notificationId: "n7" });
  assert.ok(url.startsWith("https://campus.example.edu/?panel=jobs.market&params="));
  assert.deepEqual(parsePanelUrl(url), { panel: "jobs.market", params: { query: "data analyst", highlightIds: ["a1", "b2"] }, nid: "n7" });
  assert.deepEqual(parsePanelUrl(new URL(url).search), { panel: "jobs.market", params: { query: "data analyst", highlightIds: ["a1", "b2"] }, nid: "n7" });
  assert.equal(buildPanelUrl({ panel: "schedule" }, { origin: "http://localhost:5173" }), "http://localhost:5173/?panel=schedule");
});

test("stripPanelParams keeps other query keys", () => {
  assert.equal(stripPanelParams("?panel=x&params=%7B%7D&nid=1&gmail_connected=1"), "?gmail_connected=1");
  assert.equal(stripPanelParams("?panel=x"), "");
});

test("isSameOriginUrl rejects other origins", () => {
  assert.equal(isSameOriginUrl("/?panel=schedule", "http://localhost:5173"), true);
  assert.equal(isSameOriginUrl("https://evil.example/?panel=x", "http://localhost:5173"), false);
});
