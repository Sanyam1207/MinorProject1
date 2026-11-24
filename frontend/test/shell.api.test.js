// FRONTEND.md §18 shell tests (6)–(8): legacy facade + notifications API.
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { okResponse, stubHttp } from "./helpers/store.js";
import { http } from "../src/lib/http.js";
import { api } from "../src/lib/api.js";
import { getUnreadCount, listNotifications, markNotificationRead } from "../src/lib/api/notifications.js";
import { submitIssueReport } from "../src/lib/api/issueReports.js";

test("(6) api.getMyInterviews() issues GET /interviews?limit=20 and resolves with the envelope", async () => {
  const stub = stubHttp(http, (config) => okResponse(config, [{ _id: "i1", overallScore: 7 }], "Interview results loaded"));
  try {
    const envelope = await api.getMyInterviews();
    assert.equal(stub.calls[0].method, "get");
    assert.equal(stub.calls[0].url, "/interviews?limit=20");
    assert.deepEqual(envelope, { statusCode: 200, success: true, message: "Interview results loaded", data: [{ _id: "i1", overallScore: 7 }] });
  } finally {
    stub.restore();
  }
});

test("(7) a 409 {errors:['GMAIL_NOT_CONNECTED']} keeps the axios-compatible error shape", async () => {
  const stub = stubHttp(http, (config) => {
    throw new AxiosError("Request failed with status code 409", "ERR_BAD_REQUEST", config, null, {
      status: 409,
      statusText: "Conflict",
      headers: {},
      config,
      data: { success: false, message: "Connect Gmail first", errors: ["GMAIL_NOT_CONNECTED"], data: null },
    });
  });
  try {
    await assert.rejects(api.sendPROutreachEmail({ to: "a@b.c" }), (error) => {
      assert.equal(error.response.status, 409);
      assert.equal(error.response.data.message, "Connect Gmail first");
      assert.ok(error.response.data.errors.includes("GMAIL_NOT_CONNECTED"));
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("(8) listNotifications / getUnreadCount paths and shapes", async () => {
  const stub = stubHttp(http, (config) => {
    if (config.url === "/notifications") {
      return okResponse(config, {
        items: [{ _id: "n1", type: "attendance.live", title: "Attendance open", priority: "high", ui: { panel: "attendance.scan" }, readAt: null }],
        unread: 3,
        nextBefore: "2026-11-24T10:00:00.000Z",
      });
    }
    if (config.url === "/notifications/unread-count") return okResponse(config, { unread: 5 });
    if (config.url === "/notifications/n1/read") return okResponse(config, { notification: { _id: "n1", title: "x", readAt: "2026-11-25T00:00:00.000Z" } });
    throw new Error(`unexpected ${config.url}`);
  });
  try {
    const page = await listNotifications({ before: "2026-11-25T00:00:00.000Z" });
    assert.equal(stub.calls[0].method, "get");
    assert.deepEqual(stub.calls[0].params, { limit: 30, before: "2026-11-25T00:00:00.000Z" });
    assert.equal(page.unread, 3);
    assert.equal(page.nextBefore, "2026-11-24T10:00:00.000Z");
    assert.equal(page.items[0]._id, "n1");
    assert.deepEqual(page.items[0].ui, { panel: "attendance.scan" });

    assert.equal(await getUnreadCount(), 5);
    assert.equal(stub.calls[1].url, "/notifications/unread-count");

    const read = await markNotificationRead("n1");
    assert.equal(stub.calls[2].method, "post");
    assert.equal(read.readAt, "2026-11-25T00:00:00.000Z");
  } finally {
    stub.restore();
  }
});

test("issue reports send the page URL as `page` and return the server message", async () => {
  const stub = stubHttp(http, (config) => ({
    data: { statusCode: 201, success: true, message: "Thanks for reporting this.", data: { id: "r1" } },
    status: 201,
    statusText: "Created",
    headers: {},
    config,
  }));
  try {
    const result = await submitIssueReport({ name: "A", email: "a@b.co", description: " broken ", pageUrl: "http://localhost:5173/?panel=schedule" });
    assert.deepEqual(JSON.parse(stub.calls[0].data), { description: "broken", name: "A", email: "a@b.co", page: "http://localhost:5173/?panel=schedule" });
    assert.deepEqual(result, { message: "Thanks for reporting this.", id: "r1" });
  } finally {
    stub.restore();
  }
});
