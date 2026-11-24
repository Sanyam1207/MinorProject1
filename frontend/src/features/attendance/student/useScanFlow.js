// Scan state machine shared by ScanPanel and AttendPage (ATTENDANCE.md rule 8).
//
//   scanning ──decode(new token)──▶ submitting ──200──▶ done(success)
//      ▲                               │
//      └──── TOKEN_EXPIRED (keep camera, remember token, wait for a DIFFERENT one)
//                                      └──any other code──▶ done(error | already)
//
// Tokens are single-use and rotate after every scan, so in a classroom rush a
// student often loses the race for one token. The camera keeps running and the
// next different token decoded is submitted automatically.
import { useCallback, useRef, useState } from "react";
import { ATTENDANCE_EVENTS } from "../../../lib/api/attendance.js";
import { useSocketEvent } from "../../../lib/realtime.js";
import { parseAttendUrl, submitAttendance, vibrate } from "./scan.js";
import { invalidateAttendanceSummary } from "./summary.js";
import { scanErrorView } from "./view.js";

const MIN_GAP_MS = 700;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12; // backend allows 20 / minute / user
const NOTICE_THROTTLE_MS = 1500;

const INITIAL = Object.freeze({ phase: "scanning", notice: null, outcome: null });

export function useScanFlow({ initialTried = [] } = {}) {
  const [state, setState] = useState(INITIAL);
  const triedRef = useRef(null);
  if (triedRef.current === null) triedRef.current = new Set(initialTried.filter(Boolean));
  const phaseRef = useRef("scanning");
  const timesRef = useRef([]);
  const lastSessionRef = useRef(null);
  const noticeAtRef = useRef(0);
  const requestRef = useRef(0);
  const succeededRef = useRef(false);

  const finish = useCallback((outcome) => {
    phaseRef.current = "done";
    setState({ phase: "done", notice: null, outcome: { ...outcome, at: Date.now() } });
  }, []);

  const succeed = useCallback(
    (result) => {
      succeededRef.current = true;
      vibrate(80);
      invalidateAttendanceSummary();
      finish({ kind: "success", result });
    },
    [finish],
  );

  const showNotice = useCallback((notice) => {
    const now = Date.now();
    if (now - noticeAtRef.current < NOTICE_THROTTLE_MS) return;
    noticeAtRef.current = now;
    setState((previous) => (previous.phase === "scanning" && previous.notice !== notice ? { ...previous, notice } : previous));
  }, []);

  const handleDecoded = useCallback(
    (text) => {
      if (phaseRef.current !== "scanning") return;
      const parsed = parseAttendUrl(text);
      if (!parsed) {
        showNotice("not-attendance");
        return;
      }
      if (triedRef.current.has(parsed.token)) return;

      const now = Date.now();
      const recent = timesRef.current.filter((at) => now - at < WINDOW_MS);
      timesRef.current = recent;
      if (recent.length && now - recent[recent.length - 1] < MIN_GAP_MS) return;
      if (recent.length >= MAX_PER_WINDOW) {
        showNotice("slow-down");
        return;
      }

      recent.push(now);
      triedRef.current.add(parsed.token);
      lastSessionRef.current = parsed.sessionId;
      phaseRef.current = "submitting";
      const request = ++requestRef.current;
      setState((previous) => ({ ...previous, phase: "submitting" }));

      submitAttendance(
        { sessionId: parsed.sessionId, token: parsed.token },
        {
          onLocating: () => {
            if (requestRef.current === request) setState((previous) => ({ ...previous, notice: "locating" }));
          },
        },
      ).then(
        (result) => {
          if (requestRef.current !== request) return;
          succeed(result);
        },
        (error) => {
          if (requestRef.current !== request) return;
          if (phaseRef.current === "done") return; // the socket already confirmed it
          if (error?.code === "TOKEN_EXPIRED") {
            phaseRef.current = "scanning";
            noticeAtRef.current = Date.now();
            setState({ phase: "scanning", notice: "rotated", outcome: null });
            return;
          }
          const view = scanErrorView(error);
          finish({ kind: error?.code === "ALREADY_MARKED" ? "already" : "error", view, error });
        },
      );
    },
    [finish, showNotice, succeed],
  );

  // The scan's HTTP response can be lost on a flaky classroom network; the
  // server also confirms on the student's own socket room.
  useSocketEvent(ATTENDANCE_EVENTS?.CONFIRMED ?? "attendance:confirmed", (payload) => {
    if (!payload?.sessionId || payload.sessionId !== lastSessionRef.current) return;
    if (succeededRef.current) return;
    requestRef.current += 1; // ignore the pending HTTP answer; it can only agree
    succeed({
      status: payload.status,
      markedAt: null,
      session: { _id: payload.sessionId },
      course: payload.course ?? null,
      summary: null,
      viaSocket: true,
    });
  });

  /** Back to scanning (keeps the list of spent tokens). */
  const reset = useCallback(() => {
    requestRef.current += 1;
    phaseRef.current = "scanning";
    succeededRef.current = false;
    timesRef.current = [];
    setState(INITIAL);
  }, []);

  return { ...state, handleDecoded, reset };
}
