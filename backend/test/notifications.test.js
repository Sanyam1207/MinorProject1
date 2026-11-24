// Tests for the notifications module (docs/contracts/NOTIFICATIONS.md):
// notify() fan-out/dedupe/realtime, REST inbox + ownership, preferences, web push
// (disabled and configured with an injected transport), email gating and the
// copilot tools.
import { connectTestDb, disconnectTestDb, createUser, authHeader, getApp, startTestServer, sleep } from "./helpers.js";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient } from "socket.io-client";

const API = "/api/v1/notifications";

const fakeIds = (count) => Array.from({ length: count }, () => new mongoose.Types.ObjectId());

const browserSubscription = (endpoint) => ({
    endpoint,
    expirationTime: null,
    keys: {
        p256dh: crypto.createECDH("prime256v1").generateKeys().toString("base64url"),
        auth: crypto.randomBytes(16).toString("base64url"),
    },
});

const fcmEndpoint = () => `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString("hex")}`;

const connectSocket = async (url, user) => {
    const client = ioClient(url, { auth: { token: user.generateAccessToken() }, transports: ["websocket"], forceNew: true });
    try {
        await new Promise((resolve, reject) => {
            client.once("connect", resolve);
            client.once("connect_error", reject);
        });
    } catch (error) {
        client.close();
        throw error;
    }
    // Let the server-side room join settle (same as core.test.js).
    await sleep(50);
    return client;
};

const nextEvent = (client, event, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const handler = (payload) => {
        clearTimeout(timer);
        resolve(payload);
    };
    const timer = setTimeout(() => {
        client.off(event, handler);
        reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    client.once(event, handler);
});

const expectNoEvent = (client, event, waitMs = 300) => new Promise((resolve, reject) => {
    const handler = (payload) => {
        client.off(event, handler);
        reject(new Error(`unexpected "${event}": ${JSON.stringify(payload)}`));
    };
    client.on(event, handler);
    setTimeout(() => {
        client.off(event, handler);
        resolve();
    }, waitMs);
});

const isApiError = (status, code) => (error) => {
    assert.equal(error.statusCode, status, error.message);
    assert.equal(error.errors?.[0]?.code, code);
    return true;
};

describe("notifications module", () => {
    let app;
    let Notification;
    let PushSubscription;
    let User;
    let notifyApi;
    let moduleDef;
    let FRONTEND_URL;

    const toolNamed = (name) => moduleDef.tools.find((tool) => tool.name === name);

    // Runs `fn` while the dedupe pre-check sees nothing, i.e. exactly as if a
    // parallel request had inserted the duplicates in between: exercises the
    // insertMany duplicate-key path deterministically.
    const withRacingDedupe = async (fn) => {
        Notification.distinct = async () => [];
        try {
            return await fn();
        } finally {
            delete Notification.distinct;
        }
    };

    before(async () => {
        await connectTestDb("notifications");
        app = await getApp();
        ({ Notification, PushSubscription } = await import("../src/modules/notifications/models.js"));
        ({ User } = await import("../src/models/user.models.js"));
        notifyApi = await import("../src/modules/notifications/notify.js");
        moduleDef = (await import("../src/modules/notifications/index.js")).default;
        ({ FRONTEND_URL } = await import("../src/config/config.js"));
        await Promise.all([Notification.init(), PushSubscription.init()]);
    });

    after(async () => {
        notifyApi?.setPushSender(null);
        notifyApi?.setMailSender(null);
        await notifyApi?.flushDeliveries();
        await disconnectTestDb();
    });

    describe("module wiring", () => {
        it("exports the module object the registry mounts", () => {
            assert.equal(moduleDef.name, "notifications");
            assert.equal(moduleDef.mountPath, "/api/v1/notifications");
            assert.equal(typeof moduleDef.router, "function");
            assert.deepEqual(moduleDef.tools.map((tool) => tool.name).sort(), ["notifications_list", "notifications_mark_read"]);
        });

        it("builds the per-user dedupe index and the 90-day TTL index", async () => {
            const indexes = await Notification.collection.indexes();
            const ttl = indexes.find((index) => Object.keys(index.key).length === 1 && index.key.createdAt === 1);
            assert.equal(ttl?.expireAfterSeconds, 90 * 24 * 60 * 60);
            const dedupe = indexes.find((index) => index.key.user === 1 && index.key.dedupeKey === 1);
            assert.equal(dedupe?.unique, true);
            assert.deepEqual(dedupe?.partialFilterExpression, { dedupeKey: { $type: "string" } });
            const pushIndexes = await PushSubscription.collection.indexes();
            assert.ok(pushIndexes.some((index) => index.key.endpoint === 1 && index.unique === true));
        });
    });

    describe("notify()", () => {
        it("creates one notification per unique recipient", async () => {
            const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()]);
            const result = await notifyApi.notify([a._id, String(b._id), c, a._id, "not-an-id", null], {
                type: "system",
                title: "Welcome aboard",
                body: "Your account is ready.",
                data: { courseId: "c-1" },
            });
            assert.deepEqual(result, { created: 3 });

            const docs = await Notification.find({ title: "Welcome aboard" }).lean();
            assert.equal(docs.length, 3);
            assert.deepEqual(new Set(docs.map((doc) => String(doc.user))), new Set([a, b, c].map((user) => String(user._id))));
            for (const doc of docs) {
                assert.equal(doc.type, "system");
                assert.equal(doc.body, "Your account is ready.");
                assert.equal(doc.priority, "normal");
                assert.equal(doc.readAt, null);
                assert.deepEqual(doc.data, { courseId: "c-1" });
                assert.equal(doc.ui, undefined);
                assert.ok(doc.createdAt instanceof Date);
            }

            assert.deepEqual(await notifyApi.notify(a._id, { type: "system", title: "Single id" }), { created: 1 });
            assert.deepEqual(await notifyApi.notify(new Set([String(b._id)]), { type: "system", title: "From a Set" }), { created: 1 });
        });

        it("normalises title, body, ui and priority", async () => {
            const user = await createUser();
            await notifyApi.notify(user._id, {
                type: "placement.offer.new",
                title: "T".repeat(200),
                body: "B".repeat(1500),
                priority: "urgent",
                ui: { id: "a1", panel: "offers", params: { offerId: "o-1" }, data: { big: true } },
            });
            const doc = await Notification.findOne({ user: user._id, type: "placement.offer.new" }).lean();
            assert.equal(doc.title.length, 140);
            assert.ok(doc.title.endsWith("…"));
            assert.equal(doc.body.length, 1000);
            assert.equal(doc.priority, "normal");
            assert.deepEqual(doc.ui, { panel: "offers", params: { offerId: "o-1" } });

            // Truncation never leaves half of an emoji behind.
            await notifyApi.notify(user._id, { type: "system", title: `${"a".repeat(138)}😀😀😀`, dedupeKey: "emoji" });
            const emoji = await Notification.findOne({ user: user._id, dedupeKey: "emoji" }).lean();
            assert.equal(emoji.title, `${"a".repeat(138)}…`);

            await notifyApi.notify(user._id, { type: "system", title: "Array ui", ui: [{ panel: 42 }, { panel: "notifications", params: {} }] });
            const fromArray = await Notification.findOne({ user: user._id, title: "Array ui" }).lean();
            assert.deepEqual(fromArray.ui, { panel: "notifications" });

            await notifyApi.notify(user._id, { type: "system", title: "Bad ui", ui: { panel: "not a panel!" } });
            const invalid = await Notification.findOne({ user: user._id, title: "Bad ui" }).lean();
            assert.equal(invalid.ui, undefined);
        });

        it("rejects payloads without type or title and ignores empty recipient lists", async () => {
            const user = await createUser();
            await assert.rejects(notifyApi.notify(user._id, { title: "No type" }), TypeError);
            await assert.rejects(notifyApi.notify(user._id, { type: "system", title: "   " }), TypeError);
            await assert.rejects(notifyApi.notify(user._id, null), TypeError);
            assert.deepEqual(await notifyApi.notify([], { type: "system", title: "Nobody" }), { created: 0 });
            assert.deepEqual(await notifyApi.notify(null, { type: "system", title: "Nobody" }), { created: 0 });
            assert.deepEqual(await notifyApi.notify(["bad", 42], { type: "system", title: "Nobody" }), { created: 0 });
        });

        it("dedupes per recipient when a dedupeKey is given", async () => {
            const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()]);
            const payload = { type: "attendance.reminder", title: "CS301 starts in 15 minutes", dedupeKey: "reminder:s1" };
            assert.deepEqual(await notifyApi.notify([a, b], payload), { created: 2 });
            assert.deepEqual(await notifyApi.notify([a, b], payload), { created: 0 });
            assert.deepEqual(await notifyApi.notify([a, c], payload), { created: 1 });
            assert.deepEqual(await notifyApi.notify(a, { ...payload, dedupeKey: "reminder:s2" }), { created: 1 });
            assert.equal(await Notification.countDocuments({ user: a._id, dedupeKey: "reminder:s1" }), 1);

            // Without a key, every call creates a new notification.
            await notifyApi.notify(a, { type: "system", title: "Repeatable" });
            await notifyApi.notify(a, { type: "system", title: "Repeatable" });
            assert.equal(await Notification.countDocuments({ user: a._id, title: "Repeatable" }), 2);
        });

        it("ignores duplicate-key errors from insertMany and keeps the other inserts", async () => {
            const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()]);
            const payload = { type: "attendance.cancelled", title: "Class cancelled", dedupeKey: "cancel:s9" };
            await notifyApi.notify([a, b], payload);
            const result = await withRacingDedupe(() => notifyApi.notify([a, b, c], payload));
            assert.deepEqual(result, { created: 1 });
            assert.equal(await Notification.countDocuments({ dedupeKey: "cancel:s9" }), 3);
        });

        it("never duplicates under concurrent retries", async () => {
            const recipients = fakeIds(40);
            const payload = { type: "jobfeed.matches", title: "3 new jobs match your profile", dedupeKey: "jobfeed-matches:2026-11-25", priority: "low" };
            const results = await Promise.all(Array.from({ length: 5 }, () => notifyApi.notify(recipients, payload)));
            assert.equal(results.reduce((sum, result) => sum + result.created, 0), 40);
            assert.equal(await Notification.countDocuments({ dedupeKey: "jobfeed-matches:2026-11-25" }), 40);
        });

        it("fans out to more recipients than one insert batch", async () => {
            const recipients = fakeIds(1205);
            const payload = { type: "placement.drive.new", title: "New drive: Acme – SDE", dedupeKey: "drive-new:bulk" };
            assert.deepEqual(await notifyApi.notify(recipients, payload), { created: 1205 });
            assert.deepEqual(await notifyApi.notify(recipients, payload), { created: 0 });
            assert.equal(await Notification.countDocuments({ dedupeKey: "drive-new:bulk" }), 1205);
        });

        it("notifies active users by role and filter", async () => {
            const department = `DEPT-${crypto.randomBytes(3).toString("hex")}`;
            const [t1, t2, t3, s1] = await Promise.all([
                createUser({ role: "teacher", department }),
                createUser({ role: "teacher", department: `${department}-X` }),
                createUser({ role: "teacher", department, isActive: false }),
                createUser({ role: "student", department }),
            ]);
            const payload = { type: "system", title: "Faculty meeting at 4pm", dedupeKey: `meeting:${department}` };
            assert.deepEqual(await notifyApi.notifyRole("teacher", payload, { department }), { created: 1, recipients: 1 });
            assert.equal(await Notification.countDocuments({ user: t1._id, dedupeKey: payload.dedupeKey }), 1);
            assert.equal(await Notification.countDocuments({ user: t3._id }), 0, "inactive users are skipped");

            const ids = [t1, t2, t3, s1].map((user) => user._id);
            const both = await notifyApi.notifyRole(["teacher", "student"], { type: "system", title: "Campus closed Friday" }, { _id: { $in: ids } });
            assert.deepEqual(both, { created: 3, recipients: 3 });

            const batched = await notifyApi.notifyUsersWhere({ _id: { $in: ids } }, { type: "system", title: "Batched" }, { batchSize: 1 });
            assert.deepEqual(batched, { created: 3, recipients: 3 });
            await assert.rejects(notifyApi.notifyRole("", { type: "system", title: "x" }), TypeError);
            await assert.rejects(notifyApi.notifyUsersWhere({}, { type: "system" }), TypeError);
        });
    });

    describe("realtime", () => {
        let server;
        const clients = [];
        // Closed after every test, pass or fail: a reconnecting client would keep the process alive.
        const connect = async (user) => {
            const client = await connectSocket(server.url, user);
            clients.push(client);
            return client;
        };

        before(async () => {
            server = await startTestServer();
        });
        afterEach(() => {
            for (const client of clients.splice(0)) client.close();
        });
        after(async () => {
            await server.close();
        });

        it("emits notification:new and notification:count to the recipient's room only", async () => {
            const [alice, bob] = await Promise.all([createUser(), createUser()]);
            await notifyApi.notify(alice._id, { type: "system", title: "Earlier one" });
            const aliceSocket = await connect(alice);
            const bobSocket = await connect(bob);

            const created = nextEvent(aliceSocket, "notification:new");
            const counted = nextEvent(aliceSocket, "notification:count");
            const bobSilent = expectNoEvent(bobSocket, "notification:new");
            const result = await notifyApi.notify(alice._id, {
                type: "placement.offer.new",
                title: "Offer from Acme: 12 LPA",
                body: "SDE-1. Respond by 5 Dec.",
                priority: "high",
                ui: { panel: "offers", params: { offerId: "o-42" } },
            });
            assert.deepEqual(result, { created: 1 });

            const { notification } = await created;
            assert.equal(notification.title, "Offer from Acme: 12 LPA");
            assert.equal(notification.type, "placement.offer.new");
            assert.equal(notification.user, String(alice._id));
            assert.equal(notification.priority, "high");
            assert.equal(notification.readAt, null);
            assert.deepEqual(notification.ui, { panel: "offers", params: { offerId: "o-42" } });
            assert.match(notification._id, /^[a-f\d]{24}$/);
            assert.ok(!Number.isNaN(Date.parse(notification.createdAt)));

            const { unread } = await counted;
            assert.equal(unread, 2);
            await bobSilent;
        });

        it("emits only for notifications that were actually inserted", async () => {
            const [alice, bob] = await Promise.all([createUser(), createUser()]);
            const payload = { type: "attendance.live", title: "CS301 attendance is live", dedupeKey: "live:s77" };
            await notifyApi.notify(alice._id, payload);
            const aliceSocket = await connect(alice);
            const bobSocket = await connect(bob);

            const aliceSilent = expectNoEvent(aliceSocket, "notification:new");
            const bobReceives = nextEvent(bobSocket, "notification:new");
            const result = await withRacingDedupe(() => notifyApi.notify([alice._id, bob._id], payload));
            assert.deepEqual(result, { created: 1 });
            assert.equal((await bobReceives).notification.user, String(bob._id));
            await aliceSilent;
        });

        it("pushes the new unread count when notifications are read over REST", async () => {
            const user = await createUser();
            await notifyApi.notify(user._id, { type: "system", title: "One" });
            await notifyApi.notify(user._id, { type: "system", title: "Two" });
            const target = await Notification.findOne({ user: user._id, title: "One" }).lean();
            const socket = await connect(user);

            const counted = nextEvent(socket, "notification:count");
            const res = await request(app).post(`${API}/${target._id}/read`).set(authHeader(user));
            assert.equal(res.status, 200);
            assert.deepEqual(await counted, { unread: 1 });

            const cleared = nextEvent(socket, "notification:count");
            await request(app).post(`${API}/read-all`).set(authHeader(user));
            assert.deepEqual(await cleared, { unread: 0 });
        });
    });

    describe("REST inbox", () => {
        const seed = async (user, specs) => Notification.insertMany(
            specs.map((spec) => ({ user: user._id, type: "system", priority: "normal", readAt: null, ...spec })),
            { timestamps: false },
        );

        it("requires authentication", async () => {
            assert.equal((await request(app).get(API)).status, 401);
            assert.equal((await request(app).get(`${API}/unread-count`)).status, 401);
            assert.equal((await request(app).post(`${API}/read-all`)).status, 401);
        });

        it("lists newest first with before-cursor pagination", async () => {
            const user = await createUser();
            const base = Date.now() - 60 * 60_000;
            await seed(user, [0, 1, 2, 3, 4].map((minute) => ({
                title: `n${minute}`,
                createdAt: new Date(base + minute * 60_000),
                readAt: minute === 2 ? new Date() : null,
            })));

            const page1 = await request(app).get(`${API}?limit=2`).set(authHeader(user));
            assert.equal(page1.status, 200);
            assert.equal(page1.body.success, true);
            assert.deepEqual(page1.body.data.items.map((item) => item.title), ["n4", "n3"]);
            assert.equal(page1.body.data.unread, 4);
            assert.equal(page1.body.data.nextBefore, new Date(base + 3 * 60_000).toISOString());

            const page2 = await request(app).get(API).query({ limit: 2, before: page1.body.data.nextBefore }).set(authHeader(user));
            assert.deepEqual(page2.body.data.items.map((item) => item.title), ["n2", "n1"]);
            assert.equal(page2.body.data.unread, 4);

            const page3 = await request(app).get(API).query({ limit: 2, before: page2.body.data.nextBefore }).set(authHeader(user));
            assert.deepEqual(page3.body.data.items.map((item) => item.title), ["n0"]);
            assert.equal(page3.body.data.nextBefore, null);

            const unreadOnly = await request(app).get(`${API}?unreadOnly=true`).set(authHeader(user));
            assert.deepEqual(unreadOnly.body.data.items.map((item) => item.title), ["n4", "n3", "n1", "n0"]);
            assert.ok(unreadOnly.body.data.items.every((item) => item.readAt === null));
            assert.equal(unreadOnly.body.data.nextBefore, null);

            const first = page1.body.data.items[0];
            assert.equal(typeof first._id, "string");
            assert.equal(first.user, String(user._id));
            assert.equal(first.type, "system");

            const bad = await request(app).get(`${API}?before=yesterday-ish`).set(authHeader(user));
            assert.equal(bad.status, 400);
            assert.equal(bad.body.errors[0].code, "VALIDATION");
        });

        it("never skips notifications that share the page-boundary timestamp", async () => {
            const user = await createUser();
            const tie = new Date(Date.now() - 5 * 60_000);
            await seed(user, [
                { title: "tie-a", createdAt: tie },
                { title: "tie-b", createdAt: tie },
                { title: "tie-c", createdAt: tie },
                { title: "older", createdAt: new Date(tie.getTime() - 60_000) },
            ]);
            const seen = [];
            let before;
            for (let guard = 0; guard < 5; guard += 1) {
                const res = await request(app).get(API).query({ limit: 2, ...(before ? { before } : {}) }).set(authHeader(user));
                seen.push(...res.body.data.items.map((item) => item.title));
                before = res.body.data.nextBefore;
                if (!before) break;
            }
            assert.deepEqual([...seen].sort(), ["older", "tie-a", "tie-b", "tie-c"]);
            assert.equal(seen.at(-1), "older");
        });

        it("counts, reads, reads all and deletes", async () => {
            const user = await createUser();
            await notifyApi.notify(user._id, { type: "system", title: "First" });
            await notifyApi.notify(user._id, { type: "system", title: "Second" });
            await notifyApi.notify(user._id, { type: "system", title: "Third" });
            const first = await Notification.findOne({ user: user._id, title: "First" }).lean();
            const third = await Notification.findOne({ user: user._id, title: "Third" }).lean();

            const count = await request(app).get(`${API}/unread-count`).set(authHeader(user));
            assert.equal(count.status, 200);
            assert.deepEqual(count.body.data, { unread: 3 });

            const read = await request(app).post(`${API}/${first._id}/read`).set(authHeader(user));
            assert.equal(read.status, 200);
            assert.equal(read.body.data.notification._id, String(first._id));
            assert.ok(read.body.data.notification.readAt);
            const again = await request(app).post(`${API}/${first._id}/read`).set(authHeader(user));
            assert.equal(again.status, 200);
            assert.equal(again.body.data.notification.readAt, read.body.data.notification.readAt, "re-reading keeps the first readAt");
            assert.deepEqual((await request(app).get(`${API}/unread-count`).set(authHeader(user))).body.data, { unread: 2 });

            const all = await request(app).post(`${API}/read-all`).set(authHeader(user));
            assert.equal(all.status, 200);
            assert.deepEqual(all.body.data, { updated: 2 });
            assert.deepEqual((await request(app).post(`${API}/read-all`).set(authHeader(user))).body.data, { updated: 0 });
            assert.deepEqual((await request(app).get(`${API}/unread-count`).set(authHeader(user))).body.data, { unread: 0 });

            const removed = await request(app).delete(`${API}/${third._id}`).set(authHeader(user));
            assert.equal(removed.status, 200);
            assert.deepEqual(removed.body.data, { deleted: true });
            assert.equal(await Notification.countDocuments({ _id: third._id }), 0);
            const missing = await request(app).delete(`${API}/${third._id}`).set(authHeader(user));
            assert.equal(missing.status, 404);
            assert.equal(missing.body.errors[0].code, "NOT_FOUND");
        });

        it("keeps every user's notifications private", async () => {
            const [owner, intruder] = await Promise.all([createUser(), createUser()]);
            await notifyApi.notify(owner._id, { type: "placement.offer.new", title: "Owner's offer" });
            const mine = await Notification.findOne({ user: owner._id }).lean();

            const read = await request(app).post(`${API}/${mine._id}/read`).set(authHeader(intruder));
            assert.equal(read.status, 404);
            assert.equal(read.body.errors[0].code, "NOT_FOUND");
            const removed = await request(app).delete(`${API}/${mine._id}`).set(authHeader(intruder));
            assert.equal(removed.status, 404);
            const list = await request(app).get(API).set(authHeader(intruder));
            assert.equal(list.status, 200);
            assert.ok(!list.body.data.items.some((item) => item._id === String(mine._id)));
            assert.deepEqual((await request(app).post(`${API}/read-all`).set(authHeader(intruder))).body.data, { updated: 0 });

            const untouched = await Notification.findById(mine._id).lean();
            assert.ok(untouched, "the owner's notification still exists");
            assert.equal(untouched.readAt, null, "and is still unread");
        });

        it("rejects malformed ids", async () => {
            const user = await createUser();
            const read = await request(app).post(`${API}/not-an-id/read`).set(authHeader(user));
            assert.equal(read.status, 400);
            assert.equal(read.body.errors[0].code, "VALIDATION");
            assert.equal((await request(app).delete(`${API}/12345`).set(authHeader(user))).status, 400);
        });
    });

    describe("preferences", () => {
        it("returns defaults, validates and saves partial updates", async () => {
            const user = await createUser();
            const initial = await request(app).get(`${API}/preferences`).set(authHeader(user));
            assert.equal(initial.status, 200);
            assert.deepEqual(initial.body.data, { email: false, push: true, mutedTypes: [] });

            const saved = await request(app).put(`${API}/preferences`).set(authHeader(user))
                .send({ email: true, mutedTypes: ["Attendance.", "placement.*", "system", "attendance."] });
            assert.equal(saved.status, 200);
            assert.deepEqual(saved.body.data, { email: true, push: true, mutedTypes: ["attendance.", "placement.", "system"] });

            const partial = await request(app).put(`${API}/preferences`).set(authHeader(user)).send({ push: false });
            assert.deepEqual(partial.body.data, { email: true, push: false, mutedTypes: ["attendance.", "placement.", "system"] });
            const fetched = await request(app).get(`${API}/preferences`).set(authHeader(user));
            assert.deepEqual(fetched.body.data, partial.body.data);
            const stored = await User.findById(user._id).select("notificationPreferences").lean();
            assert.equal(stored.notificationPreferences.push, false);

            const cleared = await request(app).put(`${API}/preferences`).set(authHeader(user)).send({ mutedTypes: [] });
            assert.deepEqual(cleared.body.data.mutedTypes, []);

            for (const body of [{ email: "maybe" }, { push: 1 }, { mutedTypes: ["bad prefix!"] }, { mutedTypes: 5 }, { mutedTypes: [7] }, {}]) {
                const res = await request(app).put(`${API}/preferences`).set(authHeader(user)).send(body);
                assert.equal(res.status, 400, JSON.stringify(body));
                assert.equal(res.body.errors[0].code, "VALIDATION");
            }
        });
    });

    describe("web push without VAPID keys", () => {
        it("reports push as disabled and refuses subscriptions", async () => {
            const user = await createUser();
            const key = await request(app).get(`${API}/push/public-key`).set(authHeader(user));
            assert.equal(key.status, 200);
            assert.deepEqual(key.body.data, { enabled: false, publicKey: null });

            const subscribe = await request(app).post(`${API}/push/subscribe`).set(authHeader(user))
                .send({ subscription: browserSubscription(fcmEndpoint()) });
            assert.equal(subscribe.status, 503);
            assert.equal(subscribe.body.errors[0].code, "PUSH_DISABLED");
            assert.equal(await PushSubscription.countDocuments({ user: user._id }), 0);

            const unsubscribe = await request(app).post(`${API}/push/unsubscribe`).set(authHeader(user))
                .send({ endpoint: fcmEndpoint() });
            assert.equal(unsubscribe.status, 200);
            assert.deepEqual(unsubscribe.body.data, { unsubscribed: true, removed: false });

            const missing = await request(app).post(`${API}/push/unsubscribe`).set(authHeader(user)).send({});
            assert.equal(missing.status, 400);

            // notify() still works and schedules no push work.
            assert.deepEqual(await notifyApi.notify(user._id, { type: "system", title: "No push", priority: "high" }), { created: 1 });
            await notifyApi.flushDeliveries();
        });
    });

    describe("web push with VAPID keys", () => {
        const saved = {};
        let keys;
        let sent;

        before(async () => {
            for (const name of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) saved[name] = process.env[name];
            const { generateVAPIDKeys } = await import("web-push");
            keys = generateVAPIDKeys();
            process.env.VAPID_PUBLIC_KEY = keys.publicKey;
            process.env.VAPID_PRIVATE_KEY = keys.privateKey;
            process.env.VAPID_SUBJECT = "mailto:push-tests@example.com";
            notifyApi.setPushSender(async (subscription, payload, options) => {
                sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
                if (subscription.endpoint.includes("/gone-")) {
                    throw Object.assign(new Error("Received unexpected response code"), { statusCode: 410 });
                }
                return { statusCode: 201 };
            });
        });

        after(() => {
            notifyApi.setPushSender(null);
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        });

        const subscribe = (user, subscription) => request(app).post(`${API}/push/subscribe`).set(authHeader(user))
            .set("User-Agent", "notifications-test-agent").send({ subscription });

        const pushesAfter = async (fn) => {
            sent = [];
            await fn();
            await notifyApi.flushDeliveries();
            return sent;
        };

        it("publishes the public key", async () => {
            const user = await createUser();
            const res = await request(app).get(`${API}/push/public-key`).set(authHeader(user));
            assert.deepEqual(res.body.data, { enabled: true, publicKey: keys.publicKey });
        });

        it("validates and stores browser subscriptions", async () => {
            const user = await createUser();
            const rejected = [
                [{ ...browserSubscription(fcmEndpoint()), endpoint: "http://fcm.googleapis.com/fcm/send/x" }, "PUSH_ENDPOINT_NOT_ALLOWED"],
                [browserSubscription("https://push.evil.example.com/send/x"), "PUSH_ENDPOINT_NOT_ALLOWED"],
                [browserSubscription("https://127.0.0.1/send/x"), "PUSH_ENDPOINT_NOT_ALLOWED"],
                [browserSubscription("https://fcm.googleapis.com:8443/fcm/send/x"), "PUSH_ENDPOINT_NOT_ALLOWED"],
                [{ endpoint: fcmEndpoint() }, "VALIDATION"],
                [{ ...browserSubscription(fcmEndpoint()), keys: { p256dh: "c2hvcnQ", auth: crypto.randomBytes(16).toString("base64url") } }, "VALIDATION"],
                ["not-an-object", "VALIDATION"],
            ];
            for (const [subscription, code] of rejected) {
                const res = await subscribe(user, subscription);
                assert.equal(res.status, 400, JSON.stringify(subscription));
                assert.equal(res.body.errors[0].code, code);
            }
            assert.equal(await PushSubscription.countDocuments({ user: user._id }), 0);

            const subscription = browserSubscription(fcmEndpoint());
            const ok = await subscribe(user, subscription);
            assert.equal(ok.status, 200);
            assert.deepEqual(ok.body.data, { subscribed: true });
            const stored = await PushSubscription.findOne({ endpoint: subscription.endpoint }).lean();
            assert.equal(String(stored.user), String(user._id));
            assert.deepEqual(stored.keys, subscription.keys);
            assert.equal(stored.userAgent, "notifications-test-agent");
            assert.equal((await subscribe(user, subscription)).status, 200, "re-subscribing is idempotent");
            assert.equal(await PushSubscription.countDocuments({ endpoint: subscription.endpoint }), 1);

            // A shared device: the endpoint follows the account that subscribed last.
            const nextUser = await createUser();
            assert.equal((await subscribe(nextUser, subscription)).status, 200);
            assert.equal(String((await PushSubscription.findOne({ endpoint: subscription.endpoint }).lean()).user), String(nextUser._id));
            const notMine = await request(app).post(`${API}/push/unsubscribe`).set(authHeader(user)).send({ endpoint: subscription.endpoint });
            assert.deepEqual(notMine.body.data, { unsubscribed: true, removed: false });
            const mine = await request(app).post(`${API}/push/unsubscribe`).set(authHeader(nextUser)).send({ endpoint: subscription.endpoint });
            assert.deepEqual(mine.body.data, { unsubscribed: true, removed: true });
            assert.equal(await PushSubscription.countDocuments({ endpoint: subscription.endpoint }), 0);
        });

        it("keeps at most 10 devices per user", async () => {
            const user = await createUser();
            for (let index = 0; index < 12; index += 1) {
                assert.equal((await subscribe(user, browserSubscription(fcmEndpoint()))).status, 200);
            }
            assert.equal(await PushSubscription.countDocuments({ user: user._id }), 10);
        });

        it("sends the deep-link payload and prunes subscriptions that are gone", async () => {
            const user = await createUser();
            const live = browserSubscription(fcmEndpoint());
            const gone = browserSubscription(`https://updates.push.services.mozilla.com/wpush/v2/gone-${crypto.randomBytes(6).toString("hex")}`);
            await subscribe(user, live);
            await subscribe(user, gone);

            const calls = await pushesAfter(() => notifyApi.notify(user._id, {
                type: "placement.offer.new",
                title: "Offer from Acme: 12 LPA",
                body: "SDE-1. Respond by 5 Dec.",
                priority: "high",
                ui: { panel: "offers", params: { offerId: "o 1" } },
            }));
            assert.equal(calls.length, 2);
            const notification = await Notification.findOne({ user: user._id, type: "placement.offer.new" }).lean();
            const id = String(notification._id);
            const call = calls.find((entry) => entry.endpoint === live.endpoint);
            assert.deepEqual(call.payload, {
                title: "Offer from Acme: 12 LPA",
                body: "SDE-1. Respond by 5 Dec.",
                url: `${FRONTEND_URL}/?panel=offers&params=${encodeURIComponent(JSON.stringify({ offerId: "o 1" }))}&nid=${id}`,
                tag: id,
                notificationId: id,
                priority: "high",
            });
            assert.equal(call.options.urgency, "high");
            assert.equal(call.options.TTL, 24 * 60 * 60);
            assert.equal(call.options.vapidDetails.publicKey, keys.publicKey);
            assert.equal(call.options.vapidDetails.subject, "mailto:push-tests@example.com");

            assert.equal(await PushSubscription.countDocuments({ endpoint: gone.endpoint }), 0, "410 removes the subscription");
            assert.equal(await PushSubscription.countDocuments({ endpoint: live.endpoint }), 1);

            const system = await pushesAfter(() => notifyApi.notify(user._id, {
                type: "system", title: "Maintenance tonight", priority: "high", dedupeKey: "maint:1",
            }));
            const systemId = String((await Notification.findOne({ user: user._id, dedupeKey: "maint:1" }).lean())._id);
            assert.equal(system.length, 1);
            assert.equal(system[0].payload.url, `${FRONTEND_URL}/?panel=notifications&params=%7B%7D&nid=${systemId}`);
            assert.equal(system[0].payload.tag, "maint:1");
        });

        it("honours priority, the push flag, preferences and muted types", async () => {
            const user = await createUser();
            await subscribe(user, browserSubscription(fcmEndpoint()));
            const base = { type: "placement.application.status", title: "Shortlisted at Acme" };

            assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { ...base, priority: "low" }))).length, 0);
            assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { ...base, priority: "high", push: false }))).length, 0);
            const normal = await pushesAfter(() => notifyApi.notify(user._id, base));
            assert.equal(normal.length, 1, "normal priority pushes to a user without an open app");
            assert.equal(normal[0].options.urgency, "normal");

            await request(app).put(`${API}/preferences`).set(authHeader(user)).send({ push: false });
            assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { ...base, priority: "high" }))).length, 0);

            await request(app).put(`${API}/preferences`).set(authHeader(user)).send({ push: true, mutedTypes: ["placement."] });
            assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { ...base, priority: "high" }))).length, 0);
            const other = await pushesAfter(() => notifyApi.notify(user._id, { type: "attendance.live", title: "Attendance is live", priority: "high" }));
            assert.equal(other.length, 1);

            const muted = await Notification.countDocuments({ user: user._id, type: "placement.application.status" });
            assert.equal(muted, 5, "muting never hides the in-app notification");
        });

        it("skips normal-priority push while the user has the app open", async () => {
            const user = await createUser();
            await subscribe(user, browserSubscription(fcmEndpoint()));
            const server = await startTestServer();
            let socket;
            try {
                socket = await connectSocket(server.url, user);
                assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { type: "system", title: "Quiet" }))).length, 0);
                assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { type: "system", title: "Loud", priority: "high" }))).length, 1);
                socket.close();
                await sleep(150);
                assert.equal((await pushesAfter(() => notifyApi.notify(user._id, { type: "system", title: "Offline again" }))).length, 1);
            } finally {
                // Always close the client: a reconnecting socket would keep the test process alive.
                socket?.close();
                await server.close();
            }
        });
    });

    describe("email", () => {
        let mails;

        before(() => {
            notifyApi.setMailSender(async (message) => {
                mails.push(message);
                return { messageId: `test-${mails.length}` };
            });
        });

        after(() => {
            notifyApi.setMailSender(null);
        });

        const mailsAfter = async (fn) => {
            mails = [];
            await fn();
            await notifyApi.flushDeliveries();
            return mails;
        };

        it("emails only users who opted in, did not mute the type and are active", async () => {
            const [optedIn, defaults, muted, inactive] = await Promise.all([
                createUser({ notificationPreferences: { email: true } }),
                createUser(),
                createUser({ notificationPreferences: { email: true, mutedTypes: ["training."] } }),
                createUser({ notificationPreferences: { email: true }, isActive: false }),
            ]);
            const everyone = [optedIn, defaults, muted, inactive].map((user) => user._id);

            const training = await mailsAfter(() => notifyApi.notify(everyone, {
                type: "training.new",
                title: "New training: Mock Interview Week",
                body: "Workshop · starts 1 Dec · LT-2",
                email: true,
                ui: { panel: "training", params: { programId: "p1" } },
            }));
            assert.deepEqual(training.map((mail) => mail.to), [optedIn.email]);
            const [mail] = training;
            const notification = await Notification.findOne({ user: optedIn._id, type: "training.new" }).lean();
            const url = `${FRONTEND_URL}/?panel=training&params=${encodeURIComponent(JSON.stringify({ programId: "p1" }))}&nid=${notification._id}`;
            assert.equal(mail.subject, "New training: Mock Interview Week");
            assert.ok(mail.text.includes("Workshop · starts 1 Dec · LT-2"));
            assert.ok(mail.text.includes(url));
            assert.ok(mail.html.includes("New training: Mock Interview Week"));
            assert.ok(mail.html.includes(url.replaceAll("&", "&amp;")));

            const attendance = await mailsAfter(() => notifyApi.notify(everyone, { type: "attendance.low", title: "Attendance below 75%", email: true }));
            assert.deepEqual(attendance.map((entry) => entry.to).sort(), [optedIn.email, muted.email].sort());

            assert.equal((await mailsAfter(() => notifyApi.notify(everyone, { type: "attendance.low", title: "No email flag" }))).length, 0);
        });

        it("never fails notify() when email delivery fails", async () => {
            const user = await createUser({ notificationPreferences: { email: true } });
            notifyApi.setMailSender(async () => {
                throw new Error("SMTP exploded");
            });
            try {
                assert.deepEqual(await notifyApi.notify(user._id, { type: "system", title: "Still saved", email: true }), { created: 1 });
                await notifyApi.flushDeliveries();
                assert.equal(await Notification.countDocuments({ user: user._id, title: "Still saved" }), 1);
            } finally {
                notifyApi.setMailSender(async (message) => {
                    mails.push(message);
                });
            }
        });
    });

    describe("agent tools", () => {
        const ALL_ROLES = ["student", "teacher", "tpo", "admin", "company", "alumni"];

        it("define both tools per AGENT-TOOLS §2", () => {
            for (const name of ["notifications_list", "notifications_mark_read"]) {
                const tool = toolNamed(name);
                assert.ok(tool, name);
                assert.match(tool.name, /^[a-z][a-z0-9_]{2,63}$/);
                assert.equal(typeof tool.description, "string");
                assert.ok(tool.description.length > 20);
                assert.deepEqual([...tool.roles].sort(), [...ALL_ROLES].sort());
                assert.equal(tool.confirm, false);
                assert.equal(tool.parameters.type, "object");
                assert.equal(typeof tool.parameters.properties, "object");
                assert.equal(typeof tool.handler, "function");
            }
            assert.equal(toolNamed("notifications_mark_read").parameters.properties.ids.items.type, "string");
        });

        it("notifications_list returns only the caller's notifications and opens the panel", async () => {
            const [user, stranger] = await Promise.all([createUser(), createUser({ role: "teacher" })]);
            const base = Date.now() - 30 * 60_000;
            await Notification.insertMany([
                { user: user._id, type: "attendance.scheduled", title: "CS301 scheduled for Tue 10:00", body: "Room LT-2", createdAt: new Date(base) },
                { user: user._id, type: "placement.offer.new", title: "Offer from Acme: 12 LPA", priority: "high", createdAt: new Date(base + 60_000) },
                { user: user._id, type: "system", title: "Old news", readAt: new Date(), createdAt: new Date(base + 120_000) },
                { user: stranger._id, type: "system", title: "Stranger's secret", createdAt: new Date(base) },
            ], { timestamps: false });

            const list = toolNamed("notifications_list");
            const result = await list.handler({}, { user, role: "student", timezone: "Asia/Kolkata", now: new Date() });
            assert.deepEqual(result.ui, { panel: "notifications" });
            assert.equal(result.data.unread, 2);
            assert.equal(result.data.items.length, 3);
            assert.equal(result.data.hasMore, false);
            assert.ok(result.data.items.every((item) => /^[a-f\d]{24}$/.test(item.id)));
            assert.ok(!result.data.items.some((item) => item.title === "Stranger's secret"));
            assert.equal(result.data.items.find((item) => item.title === "Old news").read, true);
            assert.match(result.summary, /2 unread notifications/);
            assert.ok(result.summary.includes("Offer from Acme: 12 LPA"));
            assert.ok(result.summary.includes("[important]"));

            assert.equal(result.data.items[0].title, "Old news", "newest first");

            const unreadOnly = await list.handler({ unreadOnly: "true", limit: "1" }, { user, role: "student" });
            assert.deepEqual(unreadOnly.data.items.map((item) => [item.title, item.read]), [["Offer from Acme: 12 LPA", false]]);
            assert.equal(unreadOnly.data.hasMore, true);
            assert.match(unreadOnly.summary, /Unread \(1; older ones are in the notifications panel\)/);

            const empty = await list.handler({}, { user: await createUser({ role: "alumni" }), role: "alumni" });
            assert.equal(empty.summary, "You have no notifications.");
            assert.deepEqual(empty.data.items, []);
        });

        it("notifications_mark_read marks ids or everything, for the caller only", async () => {
            const [user, stranger] = await Promise.all([createUser(), createUser()]);
            for (const title of ["A", "B", "C"]) await notifyApi.notify(user._id, { type: "system", title });
            await notifyApi.notify(stranger._id, { type: "system", title: "Not yours" });
            const [a] = await Notification.find({ user: user._id, title: "A" }).lean();
            const foreign = await Notification.findOne({ user: stranger._id }).lean();
            const markRead = toolNamed("notifications_mark_read");
            const ctx = { user, role: "student" };

            const one = await markRead.handler({ ids: [String(a._id)] }, ctx);
            assert.deepEqual(one.data, { updated: 1, unread: 2 });
            assert.equal(one.ui, undefined);
            assert.match(one.summary, /Marked 1 notification as read/);

            const repeat = await markRead.handler({ ids: `${a._id}, ${foreign._id}` }, ctx);
            assert.deepEqual(repeat.data, { updated: 0, unread: 2 });
            assert.match(repeat.summary, /already read/);
            assert.match(repeat.summary, /1 id did not match/);
            assert.equal((await Notification.findById(foreign._id).lean()).readAt, null, "never touches other users");

            await assert.rejects(markRead.handler({ ids: [String(foreign._id)] }, ctx), isApiError(404, "NOT_FOUND"));
            await assert.rejects(markRead.handler({}, ctx), isApiError(400, "VALIDATION"));
            await assert.rejects(markRead.handler({ ids: ["the offer one"] }, ctx), isApiError(400, "VALIDATION"));

            const all = await markRead.handler({ all: true }, ctx);
            assert.deepEqual(all.data, { updated: 2, unread: 0 });
            assert.match(all.summary, /Marked 2 notifications as read/);
            const none = await markRead.handler({ all: true }, ctx);
            assert.equal(none.summary, "You had no unread notifications.");
            assert.equal((await Notification.findById(foreign._id).lean()).readAt, null);
        });

        it("require an authenticated user in the context", async () => {
            await assert.rejects(toolNamed("notifications_list").handler({}, {}), isApiError(401, "UNAUTHORIZED"));
            await assert.rejects(toolNamed("notifications_mark_read").handler({ all: true }, {}), isApiError(401, "UNAUTHORIZED"));
        });
    });
});
