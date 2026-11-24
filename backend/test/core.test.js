import { connectTestDb, disconnectTestDb, createUser, authHeader, getApp, startTestServer } from "./helpers.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { io as ioClient } from "socket.io-client";

describe("core platform", () => {
    let app;
    before(async () => {
        await connectTestDb("core");
        app = await getApp();
    });
    after(disconnectTestDb);

    it("reports health with the database state", async () => {
        const res = await request(app).get("/api/v1/healthcheck");
        assert.equal(res.status, 200);
        assert.equal(res.body.data.database, "up");
    });

    it("answers unknown API routes with a JSON 404", async () => {
        const res = await request(app).get("/api/v1/definitely-not-a-route");
        assert.equal(res.status, 404);
        assert.equal(res.body.success, false);
        assert.equal(res.body.errors[0].code, "NOT_FOUND");
    });

    it("never serialises secrets on the user document", async () => {
        const user = await createUser({ refreshToken: "secret-refresh" });
        const json = JSON.parse(JSON.stringify(user));
        assert.equal(json.password, undefined);
        assert.equal(json.refreshToken, undefined);
        assert.equal(json.llmCredentials, undefined);
        assert.equal(json.email, user.email);
    });

    it("accepts the teacher role", async () => {
        const teacher = await createUser({ role: "teacher", department: "CSE" });
        assert.equal(teacher.role, "teacher");
    });

    it("rejects requests with an invalid bearer token", async () => {
        const res = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer not-a-token");
        assert.equal(res.status, 401);
    });

    it("returns the current user without secrets", async () => {
        const user = await createUser();
        const res = await request(app).get("/api/v1/auth/me").set(authHeader(user));
        assert.equal(res.status, 200);
        const body = JSON.stringify(res.body);
        assert.ok(!body.includes("refreshToken"), "refreshToken must not be returned");
        assert.ok(!body.includes("\"password\""), "password must not be returned");
    });

    it("joins authenticated sockets to their user room", async () => {
        const server = await startTestServer();
        const user = await createUser();
        const client = ioClient(server.url, { auth: { token: user.generateAccessToken() }, transports: ["websocket"] });
        try {
            await new Promise((resolve, reject) => {
                client.on("connect", resolve);
                client.on("connect_error", reject);
            });
            const { emitToUser } = await import("../src/core/realtime.js");
            const received = new Promise((resolve) => client.on("test:ping", resolve));
            // Wait a tick for the server-side join to complete.
            await new Promise((r) => setTimeout(r, 50));
            emitToUser(user._id, "test:ping", { ok: true });
            assert.deepEqual(await received, { ok: true });
        } finally {
            client.close();
            await server.close();
        }
    });

    it("rejects chat queries from unauthenticated sockets with a terminal chunk", async () => {
        const server = await startTestServer();
        const client = ioClient(server.url, { transports: ["websocket"] });
        try {
            await new Promise((resolve) => client.on("connect", resolve));
            const response = new Promise((resolve) => client.on("response", resolve));
            client.emit("query", { requestId: "r1", user_query: "hello", user_role: "student", sessionId: "s1" });
            const chunk = await response;
            assert.equal(chunk.isEnd, true);
            assert.equal(chunk.header_message, "auth:required");
        } finally {
            client.close();
            await server.close();
        }
    });
});
