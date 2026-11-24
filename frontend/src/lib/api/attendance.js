// Attendance API client (FRONTEND.md §14.4, backend: ATTENDANCE.md, routes in
// backend/src/modules/attendance/routes.js). Owner: attendance-teacher;
// attendance-student imports it read-only — keep every exported name.
//
// Every function goes through `http` (envelope already unwrapped to `data`),
// returns the normalized shape documented in §14.4 and lets ApiClientError
// propagate (components branch on `error.code`). The `*WithMeta` variants are
// additions for the teacher UI: they return the full backend payload (e.g.
// `{course, added, generated}`) where the §14.4 function returns only the entity.
import { errorMessage, http } from "../http.js";
import { emitWithAck } from "../realtime.js";
import { socket } from "../socket.js";

const BASE = "/attendance";
const enc = (value) => encodeURIComponent(String(value ?? ""));

/** Drop undefined / null / "" values so they never reach the query string. */
const compact = (object = {}) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));

const listOf = (data, key) => {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[key])) return data[key];
  if (data && Array.isArray(data.items)) return data.items;
  return [];
};

const arr = (value) => (Array.isArray(value) ? value : []);

export const ATTENDANCE_EVENTS = Object.freeze({
  QR: "attendance:qr",
  MARKED: "attendance:marked",
  SESSION: "attendance:session",
  CONFIRMED: "attendance:confirmed",
  PRESENTER_JOIN: "attendance:presenter:join",
  PRESENTER_LEAVE: "attendance:presenter:leave",
});

export const ATTENDANCE_ERROR_MESSAGES = Object.freeze({
  INVALID_TOKEN: "This QR code isn't valid. Scan the code your teacher is showing.",
  TOKEN_EXPIRED: "This QR code has expired. Scan the code on the screen again.",
  SESSION_NOT_LIVE: "Attendance for this class isn't open.",
  NOT_ENROLLED: "You're not enrolled in this course. Ask your teacher for the join code.",
  ALREADY_MARKED: "Your attendance is already marked for this class.",
  DEVICE_ALREADY_USED: "This phone was already used to mark another student in this class.",
  OUT_OF_RANGE: "You seem to be outside the classroom. Move closer and scan again.",
  LOCATION_REQUIRED: "This class needs your location. Allow location access and scan again.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait a minute and try again.",
  SCHEDULE_CONFLICT: "That time overlaps another class.",
  NO_FREE_SLOT: "No free slot found in that window.",
  NOT_FOUND: "Not found.",
  FORBIDDEN: "You don't have access to this.",
  VALIDATION: "Some details are invalid.",
});

/** §14.4 text for known codes, otherwise the server's message. */
export const attendanceErrorMessage = (error, fallback) => {
  const code = error?.code ?? error?.error;
  if (code && Object.prototype.hasOwnProperty.call(ATTENDANCE_ERROR_MESSAGES, code)) return ATTENDANCE_ERROR_MESSAGES[code];
  return errorMessage(error, fallback);
};

// ── courses ────────────────────────────────────────────────────────────────

export const listCourses = async ({ status } = {}) =>
  listOf(await http.get(`${BASE}/courses`, { params: compact({ status }) }), "courses");

/** POST /courses → full payload `{ course, added, generated }`. */
export const createCourseWithMeta = async (body) => {
  const data = await http.post(`${BASE}/courses`, body);
  return { course: data?.course ?? data ?? null, added: data?.added ?? 0, generated: data?.generated ?? 0 };
};

export const createCourse = async (body) => (await createCourseWithMeta(body)).course;

export const getCourse = async (courseId) => {
  const data = await http.get(`${BASE}/courses/${enc(courseId)}`);
  return {
    course: data?.course ?? null,
    students: arr(data?.students),
    upcoming: arr(data?.upcoming),
    summary: data?.summary ?? null,
  };
};

/** PATCH /courses/:id → `{ course, timetable: {removed, created} | null }`. */
export const updateCourseWithMeta = async (courseId, patch) => {
  const data = await http.patch(`${BASE}/courses/${enc(courseId)}`, patch);
  return { course: data?.course ?? data ?? null, timetable: data?.timetable ?? null };
};

export const updateCourse = async (courseId, patch) => (await updateCourseWithMeta(courseId, patch)).course;

export const archiveCourse = async (courseId) => {
  const data = await http.delete(`${BASE}/courses/${enc(courseId)}`);
  return data?.course ?? null;
};

export const addStudents = async (courseId, { emails, userIds } = {}) => {
  const data = await http.post(`${BASE}/courses/${enc(courseId)}/students`, compact({ emails, userIds }));
  return { added: data?.added ?? 0, notFound: arr(data?.notFound), unknownIds: arr(data?.unknownIds) };
};

export const removeStudent = async (courseId, studentId) => {
  await http.delete(`${BASE}/courses/${enc(courseId)}/students/${enc(studentId)}`);
};

export const autoEnroll = async (courseId) => {
  const data = await http.post(`${BASE}/courses/${enc(courseId)}/auto-enroll`);
  return { added: data?.added ?? 0, matched: data?.matched ?? null };
};

export const regenerateJoinCode = async (courseId) => {
  const data = await http.post(`${BASE}/courses/${enc(courseId)}/join-code`);
  return { joinCode: data?.joinCode ?? null };
};

export const joinCourse = async (joinCode) => {
  const data = await http.post(`${BASE}/courses/join`, { joinCode });
  return data?.course ?? data ?? null;
};

export const generateSessions = async (courseId, { days } = {}) => {
  const data = await http.post(`${BASE}/courses/${enc(courseId)}/generate`, compact({ days }));
  return { created: data?.created ?? 0, sessions: arr(data?.sessions) };
};

export const getCourseReport = async (courseId, { threshold } = {}) => {
  const data = await http.get(`${BASE}/courses/${enc(courseId)}/report`, { params: compact({ threshold }) });
  return {
    course: data?.course ?? null,
    held: data?.held ?? 0,
    threshold: data?.threshold ?? null,
    students: arr(data?.students),
    defaulters: arr(data?.defaulters),
  };
};

export const notifyDefaulters = async (courseId, { threshold, message } = {}) => {
  const data = await http.post(`${BASE}/courses/${enc(courseId)}/notify-defaulters`, compact({ threshold, message }));
  return {
    notified: data?.notified ?? 0,
    defaulters: data?.defaulters ?? null,
    alreadyNotified: data?.alreadyNotified ?? 0,
    threshold: data?.threshold ?? null,
  };
};

// ── sessions ───────────────────────────────────────────────────────────────

export const listSessions = async ({ from, to, courseId, status, limit } = {}) =>
  listOf(await http.get(`${BASE}/sessions`, { params: compact({ from, to, courseId, status, limit }) }), "sessions");

/** POST /sessions → `{ session, notified }`. */
export const createSessionWithMeta = async (body) => {
  const data = await http.post(`${BASE}/sessions`, body);
  return { session: data?.session ?? data ?? null, notified: data?.notified ?? 0 };
};

export const createSession = async (body) => (await createSessionWithMeta(body)).session;

export const autoScheduleSession = async (body) => {
  const data = await http.post(`${BASE}/sessions/auto`, body);
  return { session: data?.session ?? null, reason: data?.reason ?? "", notified: data?.notified ?? 0 };
};

export const getSession = async (sessionId) => {
  const data = await http.get(`${BASE}/sessions/${enc(sessionId)}`);
  return {
    session: data?.session ?? null,
    course: data?.course ?? null,
    roster: arr(data?.roster),
    stats: data?.stats ?? data?.session?.stats ?? null,
    myRecord: data?.myRecord ?? null,
  };
};

/** PATCH /sessions/:id → `{ session, changed }`. */
export const updateSessionWithMeta = async (sessionId, patch) => {
  const data = await http.patch(`${BASE}/sessions/${enc(sessionId)}`, patch);
  return { session: data?.session ?? data ?? null, changed: data?.changed !== false };
};

export const updateSession = async (sessionId, patch) => (await updateSessionWithMeta(sessionId, patch)).session;

export const cancelSession = async (sessionId, { reason } = {}) => {
  const data = await http.post(`${BASE}/sessions/${enc(sessionId)}/cancel`, compact({ reason }));
  return data?.session ?? data ?? null;
};

export const startSession = async (sessionId, { geo } = {}) => {
  const data = await http.post(`${BASE}/sessions/${enc(sessionId)}/start`, geo ? { geo } : {});
  return { session: data?.session ?? null, qr: data?.qr ?? null, alreadyLive: Boolean(data?.alreadyLive) };
};

export const endSession = async (sessionId) => {
  const data = await http.post(`${BASE}/sessions/${enc(sessionId)}/end`);
  return { session: data?.session ?? null, stats: data?.stats ?? data?.session?.stats ?? null };
};

export const getSessionQr = async (sessionId) => {
  const data = await http.get(`${BASE}/sessions/${enc(sessionId)}/qr`);
  return {
    sessionId: data?.sessionId ?? sessionId,
    token: data?.token ?? null,
    version: data?.version ?? null,
    expiresAt: data?.expiresAt ?? null,
    url: data?.url ?? null,
    rotationSeconds: data?.rotationSeconds ?? null,
  };
};

export const markRecord = async (sessionId, { studentId, status, note } = {}) => {
  const body = { studentId, status };
  if (note !== undefined) body.note = note;
  const data = await http.post(`${BASE}/sessions/${enc(sessionId)}/records`, body);
  return { record: data?.record ?? null, stats: data?.stats ?? null };
};

export const downloadSessionCsv = async (sessionId) =>
  http.get(`${BASE}/sessions/${enc(sessionId)}/export.csv`, { responseType: "blob" });

// ── student ────────────────────────────────────────────────────────────────

export const submitScan = async ({ sessionId, token, deviceId, geo }) => {
  const data = await http.post(`${BASE}/scan`, { sessionId, token, deviceId, geo });
  return {
    status: data?.status ?? null,
    markedAt: data?.markedAt ?? null,
    session: data?.session ?? null,
    course: data?.course ?? null,
    summary: data?.summary ?? null,
  };
};

export const getMySummary = async () => {
  const data = await http.get(`${BASE}/me/summary`);
  return { ...(data && typeof data === "object" ? data : {}), courses: arr(data?.courses), overall: data?.overall ?? null };
};

export const getMyHistory = async ({ courseId, limit = 50 } = {}) =>
  listOf(await http.get(`${BASE}/me/history`, { params: compact({ courseId, limit }) }), "records");

export const getMySchedule = async ({ days = 7 } = {}) =>
  listOf(await http.get(`${BASE}/me/schedule`, { params: compact({ days }) }), "sessions");

// ── presenter socket ───────────────────────────────────────────────────────

/** Join the presenter room of a LIVE session. Resolves `{ ok, qr?, stats?, session?, error?, message? }`. */
export const joinPresenter = async (sessionId) => {
  try {
    const ack = await emitWithAck(ATTENDANCE_EVENTS.PRESENTER_JOIN, { sessionId });
    return ack && typeof ack === "object" ? ack : { ok: false, error: "NO_ACK", message: "The server did not answer." };
  } catch (error) {
    return { ok: false, error: "TIMEOUT", message: errorMessage(error, "The server did not respond in time") };
  }
};

export const leavePresenter = (sessionId) => {
  if (socket.connected) socket.emit(ATTENDANCE_EVENTS.PRESENTER_LEAVE, { sessionId });
};
