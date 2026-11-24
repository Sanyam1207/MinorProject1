// Pure helpers for the live attendance state (no React, no DOM).

/**
 * Local deadline (ms) of a QR token. Uses the server's `expiresAt` unless the
 * device clock is clearly skewed, in which case it counts `rotationSeconds`
 * from the moment the token arrived.
 */
export const qrDeadline = (qr) => {
  if (!qr) return null;
  const rotationMs = Math.max(1, Number(qr.rotationSeconds) || 15) * 1000;
  const receivedAt = Number(qr.receivedAt) || 0;
  const expires = qr.expiresAt ? new Date(qr.expiresAt).getTime() : NaN;
  if (!receivedAt) return Number.isFinite(expires) ? expires : null;
  if (!Number.isFinite(expires)) return receivedAt + rotationMs;
  const left = expires - receivedAt;
  if (left > rotationMs + 2000 || left < -2000) return receivedAt + rotationMs;
  return expires;
};

/** Accept a QR payload only when it is for this session and not older than the current one. */
export const acceptQr = (current, incoming, sessionId, receivedAt) => {
  if (!incoming || !incoming.url) return current;
  if (incoming.sessionId && sessionId && String(incoming.sessionId) !== String(sessionId)) return current;
  if (current && Number.isFinite(current.version) && Number.isFinite(incoming.version) && incoming.version < current.version) return current;
  if (current && current.token === incoming.token && current.version === incoming.version) return current;
  return { ...incoming, receivedAt };
};

export const EMPTY_STATS = Object.freeze({ present: 0, late: 0, absent: 0, excused: 0, enrolled: 0 });

export const normalizeStats = (stats) => ({ ...EMPTY_STATS, ...(stats || {}) });

/** Present + late (what the presenter counter shows as "present"). */
export const attendedCount = (stats) => (Number(stats?.present) || 0) + (Number(stats?.late) || 0);

/** Newest-first list of marks, one entry per student (a re-mark replaces the old one). */
export const pushMark = (marks, record, limit = 100) => {
  if (!record) return marks;
  const studentId = record.student?._id;
  const rest = marks.filter((entry) => (studentId ? entry.student?._id !== studentId : entry._id !== record._id));
  return [record, ...rest].slice(0, limit);
};

/**
 * Roster from GET /sessions/:id merged with live marks: each mark replaces the
 * student's record. Returns [{ student, record, enrolled }].
 */
export const mergeRoster = (roster = [], marks = []) => {
  if (!marks.length) return roster;
  const latest = new Map();
  for (const mark of marks) {
    const id = mark.student?._id;
    if (id && !latest.has(id)) latest.set(id, mark);
  }
  const seen = new Set();
  const merged = roster.map((row) => {
    const id = row.student?._id;
    seen.add(id);
    const mark = latest.get(id);
    return mark ? { ...row, record: { ...(row.record || {}), ...mark, student: row.student } } : row;
  });
  for (const [id, mark] of latest) {
    if (!seen.has(id)) merged.push({ student: mark.student, record: mark, enrolled: false });
  }
  return merged;
};

/** Short label for a student card. */
export const studentLabel = (student) => student?.name || student?.email || "Student";
export const studentRoll = (student) => student?.ggsipuEnrollment || student?.rollNumber || "";
