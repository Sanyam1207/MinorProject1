// Shared helpers for backend tests (run with `npm test` → node --test).
//
// IMPORTANT: import this file FIRST in every test file, before anything from
// src/, so the test environment below is in place when src/config/config.js
// runs dotenv (dotenv never overrides variables that are already set).
//
//   import { connectTestDb, disconnectTestDb, createUser, authHeader, getApp } from "./helpers.js";
//
// Every test file gets its own throw-away database on the local MongoDB
// (TEST_MONGO_URI, default mongodb://127.0.0.1:27017), so files can run in
// parallel and never touch development data.
import crypto from "node:crypto";
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.DISABLE_SCHEDULER = "true";
process.env.ACCESS_TOKEN_SECRET ||= "test-access-secret";
process.env.REFRESH_TOKEN_SECRET ||= "test-refresh-secret";
process.env.ACCESS_TOKEN_EXPIRY ||= "1h";
process.env.REFRESH_TOKEN_EXPIRY ||= "1d";
process.env.AGENT_TOOL_SECRET ||= "test-agent-tool-secret";
process.env.ATTENDANCE_DEVICE_SECRET ||= "test-device-secret";
process.env.TOKEN_ENCRYPTION_KEY ||= "0".repeat(64);
process.env.LLM_CREDENTIAL_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.APP_TIMEZONE ||= "Asia/Kolkata";
process.env.FRONTEND_URL ||= "http://localhost:5173";
process.env.STORAGE_DRIVER = "local";
process.env.WHATSAPP_ENABLED = "false";
process.env.JOB_SYNC_INTERVAL_MINUTES = "0";
// Never send real mail or push from tests.
for (const key of ["SMTP_SERVICE", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) {
    process.env[key] = "";
}

const { default: mongoose } = await import("mongoose");
const { default: jwt } = await import("jsonwebtoken");

const randomSuffix = () => crypto.randomBytes(4).toString("hex");

/** Connect mongoose to a fresh, uniquely named test database. */
export const connectTestDb = async (label = "suite") => {
    const base = (process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017").replace(/\/+$/, "");
    const safeLabel = String(label).replace(/[^a-z0-9_]/gi, "_").slice(0, 30);
    const dbName = `minor_project_test_${safeLabel}_${randomSuffix()}`;
    await mongoose.connect(`${base}/${dbName}`, { serverSelectionTimeoutMS: 5000 });
    // Build indexes now so unique-index behaviour is deterministic in tests.
    await Promise.all(Object.values(mongoose.models).map((model) => model.init().catch(() => {})));
    return dbName;
};

/** Drop the test database and disconnect. */
export const disconnectTestDb = async () => {
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase().catch(() => {});
    }
    await mongoose.disconnect();
};

/** Create a user (password "Passw0rd!") with sensible defaults; override any field. */
export const createUser = async (overrides = {}) => {
    const { User } = await import("../src/models/user.models.js");
    const suffix = randomSuffix();
    return User.create({
        name: `Test User ${suffix}`,
        email: `user-${suffix}@demo.edu`,
        password: "Passw0rd!",
        role: "student",
        ...overrides,
    });
};

export const tokenFor = (user) => user.generateAccessToken();
export const authHeader = (user) => ({ Authorization: `Bearer ${user.generateAccessToken()}` });

/** A copilot tool token for `user` (see docs/contracts/AGENT-TOOLS.md §1). */
export const agentToolToken = (user, claims = {}) => jwt.sign(
    { sub: String(user._id), role: user.role, rid: "test-request", sid: "test-session", typ: "agent-tool", ...claims },
    process.env.AGENT_TOOL_SECRET,
    { expiresIn: "15m" },
);

/** The Express app (routes + modules mounted), without listening. */
export const getApp = async () => (await import("../src/app.js")).app;

/**
 * Start the full HTTP + socket.io server on a random port.
 * @returns {Promise<{ url: string, io: import("socket.io").Server, close: () => Promise<void> }>}
 */
export const startTestServer = async () => {
    const app = await getApp();
    const { attachSocketServer } = await import("../src/websocket/socket-server.js");
    const server = http.createServer(app);
    const io = attachSocketServer(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        io,
        close: () => new Promise((resolve) => {
            io.close();
            server.close(() => resolve());
        }),
    };
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
