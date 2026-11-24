// Black-box contract test for docs/contracts/ATTENDANCE.md, written from the
// spec (not from the implementation). Drives the real HTTP + socket.io server.
import { connectTestDb, disconnectTestDb, createUser, authHeader, startTestServer, sleep } from "../helpers.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { io as ioClient } from "socket.io-client";

const code = (res) => res.body?.errors?.[0]?.code;

describe("attendance contract: scheduling + rotating single-use QR", () => {
    let server;
    let api;
    let teacher;
    let otherTeacher;
    let students;
    let outsider;
    let course;
    let session;
    let presenter;
    const qrEvents = [];
    const markedEvents = [];

    before(async () => {
        await connectTestDb("attendance_contract");
        server = await startTestServer();
        api = () => request(server.url);
        teacher = await createUser({ role: "teacher", name: "Prof Rao", department: "CSE" });
        otherTeacher = await createUser({ role: "teacher", name: "Prof Iyer", department: "CSE" });
        students = await Promise.all(["A", "B", "C", "D"].map((letter) =>
            createUser({ role: "student", name: `Student ${letter}`, branch: "CSE", section: "A", passingYear: "2027" })));
        outsider = await createUser({ role: "student", name: "Outsider", branch: "ECE" });
    });

    after(async () => {
        presenter?.close();
        await server?.close();
        await disconnectTestDb();
    });

    it("teacher creates a course and gets a join code", async () => {
        const res = await api().post("/api/v1/attendance/courses").set(authHeader(teacher)).send({
            code: "CS301",
            name: "Database Management Systems",
            branch: "CSE",
            section: "A",
            room: "LT-2",
            // Long TTL: the time-based rotation ticker is disabled under test.
            settings: { qrRotationSeconds: 120 },
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        course = res.body.data.course;
        assert.ok(course?._id);
        assert.match(course.joinCode, /^[A-HJ-NP-Z2-9]{6}$/);
    });

    it("students cannot create courses", async () => {
        const res = await api().post("/api/v1/attendance/courses").set(authHeader(students[0])).send({ code: "X1", name: "Nope" });
        assert.equal(res.status, 403);
    });

    it("students join with the code (bad code → 404 NOT_FOUND)", async () => {
        for (const student of students) {
            const res = await api().post("/api/v1/attendance/courses/join").set(authHeader(student)).send({ joinCode: course.joinCode });
            assert.equal(res.status, 200, JSON.stringify(res.body));
        }
        const bad = await api().post("/api/v1/attendance/courses/join").set(authHeader(outsider)).send({ joinCode: "ZZZZZZ" });
        assert.equal(bad.status, 404);
        assert.equal(code(bad), "NOT_FOUND");
    });

    it("another teacher cannot manage this course", async () => {
        const res = await api().patch(`/api/v1/attendance/courses/${course._id}`).set(authHeader(otherTeacher)).send({ room: "LT-9" });
        assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
    });

    it("teacher schedules a class and every enrolled student is notified", async () => {
        const startsAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const res = await api().post("/api/v1/attendance/sessions").set(authHeader(teacher)).send({
            courseId: course._id,
            startsAt,
            durationMinutes: 60,
            topic: "Normalisation",
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        session = res.body.data.session;
        assert.equal(session.status, "scheduled");

        await sleep(100);
        const inbox = await api().get("/api/v1/notifications").set(authHeader(students[0]));
        assert.equal(inbox.status, 200);
        assert.ok(inbox.body.data.items.some((n) => n.type === "attendance.scheduled"), "scheduled notification expected");
    });

    it("overlapping sessions are rejected with SCHEDULE_CONFLICT", async () => {
        const res = await api().post("/api/v1/attendance/sessions").set(authHeader(teacher)).send({
            courseId: course._id,
            startsAt: new Date(new Date(session.startsAt).getTime() + 30 * 60_000).toISOString(),
            durationMinutes: 60,
        });
        assert.equal(res.status, 409);
        assert.equal(code(res), "SCHEDULE_CONFLICT");
    });

    it("a student cannot start the session", async () => {
        const res = await api().post(`/api/v1/attendance/sessions/${session._id}/start`).set(authHeader(students[0])).send({});
        assert.equal(res.status, 403);
    });

    it("scanning before the session is live fails with SESSION_NOT_LIVE", async () => {
        const res = await api().post("/api/v1/attendance/scan").set(authHeader(students[0]))
            .send({ sessionId: session._id, token: "not-a-real-token", deviceId: "device-a" });
        assert.equal(res.status, 409);
        assert.equal(code(res), "SESSION_NOT_LIVE");
    });

    let qr;
    it("teacher starts the session and receives a QR token + deep link", async () => {
        const res = await api().post(`/api/v1/attendance/sessions/${session._id}/start`).set(authHeader(teacher)).send({});
        assert.equal(res.status, 200, JSON.stringify(res.body));
        qr = res.body.data.qr;
        assert.ok(qr.token && qr.version >= 1 && qr.expiresAt);
        assert.ok(qr.url.includes(`s=${session._id}`) && qr.url.includes(`t=${encodeURIComponent(qr.token)}`) || qr.url.includes(qr.token));
        assert.equal(res.body.data.session.status, "live");
    });

    it("teacher's phone joins the presenter room", async () => {
        presenter = ioClient(server.url, { auth: { token: teacher.generateAccessToken() }, transports: ["websocket"] });
        presenter.on("attendance:qr", (payload) => qrEvents.push(payload));
        presenter.on("attendance:marked", (payload) => markedEvents.push(payload));
        await new Promise((resolve, reject) => {
            presenter.on("connect", resolve);
            presenter.on("connect_error", reject);
        });
        const ack = await presenter.timeout(5000).emitWithAck("attendance:presenter:join", { sessionId: session._id });
        assert.equal(ack.ok, true, JSON.stringify(ack));
        assert.equal(ack.qr.token, qr.token);
    });

    it("a student who is not on the presenter's side cannot join the presenter room", async () => {
        const spy = ioClient(server.url, { auth: { token: students[3].generateAccessToken() }, transports: ["websocket"] });
        try {
            await new Promise((resolve) => spy.on("connect", resolve));
            const ack = await spy.timeout(5000).emitWithAck("attendance:presenter:join", { sessionId: session._id });
            assert.notEqual(ack.ok, true);
        } finally {
            spy.close();
        }
    });

    it("first scan marks present, rotates the QR and pushes it to the presenter", async () => {
        const res = await api().post("/api/v1/attendance/scan").set(authHeader(students[0]))
            .send({ sessionId: session._id, token: qr.token, deviceId: "device-a" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.ok(["present", "late"].includes(res.body.data.status));
        await sleep(150);
        const rotated = qrEvents.find((event) => event.version > qr.version);
        assert.ok(rotated, "presenter should receive a rotated token");
        assert.notEqual(rotated.token, qr.token);
        assert.ok(markedEvents.some((event) => String(event.record?.student?._id) === String(students[0]._id)));
    });

    it("the photographed (old) QR no longer works: TOKEN_EXPIRED", async () => {
        const res = await api().post("/api/v1/attendance/scan").set(authHeader(students[1]))
            .send({ sessionId: session._id, token: qr.token, deviceId: "device-b" });
        assert.equal(res.status, 410);
        assert.equal(code(res), "TOKEN_EXPIRED");
    });

    it("one phone cannot mark two students, and the rejected scan does not burn the live QR", async () => {
        const live = await api().get(`/api/v1/attendance/sessions/${session._id}/qr`).set(authHeader(teacher));
        assert.equal(live.status, 200);
        const token = live.body.data.token;

        const reused = await api().post("/api/v1/attendance/scan").set(authHeader(students[1]))
            .send({ sessionId: session._id, token, deviceId: "device-a" });
        assert.equal(reused.status, 403);
        assert.equal(code(reused), "DEVICE_ALREADY_USED");

        const ok = await api().post("/api/v1/attendance/scan").set(authHeader(students[1]))
            .send({ sessionId: session._id, token, deviceId: "device-b" });
        assert.equal(ok.status, 200, "the same live token must still be valid after a rejected scan");
    });

    it("already-marked and not-enrolled scans are rejected", async () => {
        const live = await api().get(`/api/v1/attendance/sessions/${session._id}/qr`).set(authHeader(teacher));
        const token = live.body.data.token;
        const again = await api().post("/api/v1/attendance/scan").set(authHeader(students[0]))
            .send({ sessionId: session._id, token, deviceId: "device-a" });
        assert.equal(again.status, 409);
        assert.equal(code(again), "ALREADY_MARKED");

        const stranger = await api().post("/api/v1/attendance/scan").set(authHeader(outsider))
            .send({ sessionId: session._id, token, deviceId: "device-x" });
        assert.equal(stranger.status, 403);
        assert.equal(code(stranger), "NOT_ENROLLED");
    });

    it("two students racing on the same token: exactly one wins", async () => {
        // Student D is enrolled; make a fifth enrolled student for the race.
        const racer = await createUser({ role: "student", name: "Racer", branch: "CSE", section: "A" });
        await api().post("/api/v1/attendance/courses/join").set(authHeader(racer)).send({ joinCode: course.joinCode });

        const live = await api().get(`/api/v1/attendance/sessions/${session._id}/qr`).set(authHeader(teacher));
        const token = live.body.data.token;
        const [first, second] = await Promise.all([
            api().post("/api/v1/attendance/scan").set(authHeader(students[2])).send({ sessionId: session._id, token, deviceId: "device-c" }),
            api().post("/api/v1/attendance/scan").set(authHeader(racer)).send({ sessionId: session._id, token, deviceId: "device-r" }),
        ]);
        const statuses = [first.status, second.status].sort();
        assert.deepEqual(statuses, [200, 410], `expected one success and one TOKEN_EXPIRED, got ${statuses}`);
    });

    it("teacher marks a student manually", async () => {
        const res = await api().post(`/api/v1/attendance/sessions/${session._id}/records`).set(authHeader(teacher))
            .send({ studentId: String(students[3]._id), status: "excused", note: "Medical" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.record.status, "excused");
    });

    it("ending the session fills absentees and updates student summaries", async () => {
        const res = await api().post(`/api/v1/attendance/sessions/${session._id}/end`).set(authHeader(teacher)).send({});
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.session.status, "ended");

        const present = await api().get("/api/v1/attendance/me/summary").set(authHeader(students[0]));
        assert.equal(present.status, 200);
        const mine = present.body.data.courses.find((c) => String(c.course?._id || c.course) === String(course._id));
        assert.ok(mine, "course summary expected");
        assert.equal(mine.percent, 100);

        // The racer who lost the race was never marked → absent.
        const report = await api().get(`/api/v1/attendance/courses/${course._id}/report`).set(authHeader(teacher));
        assert.equal(report.status, 200);
        assert.ok(report.body.data.defaulters.length >= 1, "the absent racer must be a defaulter");
        const excused = report.body.data.students.find((row) => String(row.student?._id || row.student) === String(students[3]._id));
        assert.equal(excused.percent, null, "an excused-only student has no attendance data yet");
    });

    it("scanning after the session ended fails", async () => {
        const res = await api().post("/api/v1/attendance/scan").set(authHeader(students[3]))
            .send({ sessionId: session._id, token: "anything", deviceId: "device-d" });
        assert.equal(res.status, 409);
        assert.equal(code(res), "SESSION_NOT_LIVE");
    });

    it("exports the session as CSV", async () => {
        const res = await api().get(`/api/v1/attendance/sessions/${session._id}/export.csv`).set(authHeader(teacher));
        assert.equal(res.status, 200);
        assert.match(res.headers["content-type"], /text\/csv/);
        assert.ok(res.text.split("\n").length >= 6, "header + one row per enrolled student");
    });
});
