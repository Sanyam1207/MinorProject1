// Live session state shared by LiveSessionPanel and PresenterPage
// (FRONTEND.md §13.1). Render the consumer with `key={sessionId}` so the state
// resets when the session changes.
//
// - Loads GET /sessions/:id (session, course, roster, stats).
// - Joins the presenter room with emitWithAck("attendance:presenter:join") on
//   every socket (re)connect; leaves on unmount.
// - attendance:qr → new token; attendance:marked → stats + recent marks;
//   attendance:session → status changes (ended / cancelled).
// - While the socket is down, polls GET /sessions/:id/qr every
//   max(2, rotationSeconds/3) s and refreshes the detail every 15 s.
// - If a token's deadline passes without a new one, fetches it over REST.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATTENDANCE_EVENTS,
  getSession,
  getSessionQr,
  joinPresenter,
  leavePresenter,
} from "../../../lib/api/attendance.js";
import { useOnSocketConnect, useSocketConnected, useSocketEvent } from "../../../lib/realtime.js";
import { useAsync } from "../../../ui/useAsync.js";
import { acceptQr, mergeRoster, normalizeStats, pushMark, qrDeadline } from "./liveState.js";

export function useLiveSession(sessionId, { loadDetail = true } = {}) {
  const connected = useSocketConnected();
  const detailState = useAsync(() => getSession(sessionId), [sessionId], { enabled: Boolean(sessionId) && loadDetail });
  const detail = detailState.data;

  const [qr, setQr] = useState(null);
  const [liveStats, setLiveStats] = useState(null);
  const [sessionOverride, setSessionOverride] = useState(null);
  const [marks, setMarks] = useState([]);
  const [joinState, setJoinState] = useState({ status: "idle", error: null });

  const session = sessionOverride ?? detail?.session ?? null;
  const status = session?.status ?? null;
  const isLive = status === "live";
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const receiveQr = useCallback((incoming) => {
    const now = Date.now();
    setQr((current) => acceptQr(current, incoming, sessionIdRef.current, now));
  }, []);

  const join = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return null;
    const ack = await joinPresenter(id);
    if (id !== sessionIdRef.current) return ack;
    if (ack?.ok) {
      if (ack.qr) receiveQr(ack.qr);
      if (ack.stats) setLiveStats(normalizeStats(ack.stats));
      if (ack.session) setSessionOverride(ack.session);
      setJoinState({ status: "joined", error: null });
    } else {
      if (ack?.session) setSessionOverride(ack.session);
      setJoinState({ status: ack?.error === "SESSION_NOT_LIVE" ? "not-live" : "error", error: ack });
    }
    return ack;
  }, [receiveQr]);

  useOnSocketConnect(() => {
    join();
  });

  useEffect(
    () => () => {
      if (sessionId) leavePresenter(sessionId);
    },
    [sessionId],
  );

  useSocketEvent(ATTENDANCE_EVENTS.QR, (payload) => {
    if (payload?.sessionId && String(payload.sessionId) !== String(sessionIdRef.current)) return;
    receiveQr(payload);
  });

  useSocketEvent(ATTENDANCE_EVENTS.MARKED, (payload) => {
    if (!payload || String(payload.sessionId) !== String(sessionIdRef.current)) return;
    if (payload.stats) setLiveStats(normalizeStats(payload.stats));
    if (payload.record) setMarks((current) => pushMark(current, payload.record));
  });

  useSocketEvent(ATTENDANCE_EVENTS.SESSION, (payload) => {
    const next = payload?.session;
    if (!next || String(next._id) !== String(sessionIdRef.current)) return;
    setSessionOverride(next);
    if (next.stats) setLiveStats(normalizeStats(next.stats));
    if (next.status !== "live") setQr(null);
    else if (!qr) join();
  });

  // Fallback polling while the socket is down.
  const rotationSeconds = qr?.rotationSeconds || 15;
  const reloadDetail = detailState.reload;
  useEffect(() => {
    if (connected || !isLive || !sessionId) return undefined;
    const qrEvery = Math.max(2, rotationSeconds / 3) * 1000;
    const qrTimer = setInterval(() => {
      getSessionQr(sessionId).then(receiveQr, () => {});
    }, qrEvery);
    const detailTimer = setInterval(() => reloadDetail(), 15000);
    return () => {
      clearInterval(qrTimer);
      clearInterval(detailTimer);
    };
  }, [connected, isLive, sessionId, rotationSeconds, receiveQr, reloadDetail]);

  // A token that outlives its deadline (missed push): fetch the current one.
  const deadline = qrDeadline(qr);
  useEffect(() => {
    if (!isLive || !sessionId || !deadline) return undefined;
    const wait = Math.max(1500, deadline - Date.now() + 2500);
    const timer = setTimeout(() => {
      getSessionQr(sessionId).then(receiveQr, () => {});
    }, wait);
    return () => clearTimeout(timer);
  }, [deadline, isLive, sessionId, receiveQr]);

  // First QR over REST when the detail says live but no token arrived yet (e.g. socket offline at mount).
  const needsFirstQr = isLive && !qr && !connected;
  useEffect(() => {
    if (!needsFirstQr || !sessionId) return undefined;
    let active = true;
    getSessionQr(sessionId).then(
      (value) => {
        if (active) receiveQr(value);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [needsFirstQr, sessionId, receiveQr]);

  /** After POST /start (or a manual mark) apply the server's answer immediately. */
  const applyStart = useCallback(
    (result) => {
      if (result?.session) setSessionOverride(result.session);
      if (result?.qr) receiveQr({ ...result.qr, sessionId: result.qr.sessionId ?? sessionIdRef.current });
      if (result?.session?.stats) setLiveStats(normalizeStats(result.session.stats));
      join();
    },
    [join, receiveQr],
  );

  const applyMark = useCallback((result) => {
    if (result?.stats) setLiveStats(normalizeStats(result.stats));
    if (result?.record) setMarks((current) => pushMark(current, result.record));
  }, []);

  const applySession = useCallback((next, stats) => {
    if (next) setSessionOverride(next);
    if (stats || next?.stats) setLiveStats(normalizeStats(stats || next.stats));
    if (next && next.status !== "live") setQr(null);
  }, []);

  const stats = normalizeStats(liveStats ?? detail?.stats ?? session?.stats);

  return {
    connected,
    loading: detailState.loading && !detail,
    error: detailState.error,
    session,
    course: detail?.course ?? null,
    roster: mergeRoster(detail?.roster ?? [], marks),
    marks,
    stats,
    qr,
    deadline,
    joinState,
    isLive,
    reload: detailState.reload,
    rejoin: join,
    applyStart,
    applyMark,
    applySession,
  };
}
