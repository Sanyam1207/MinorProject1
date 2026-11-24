import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LoaderCircle, ScanQrCode } from "lucide-react";
import { ATTENDANCE_EVENTS } from "../../../lib/api/attendance.js";
import { APP_INITIALS, APP_NAME } from "../../../lib/config.js";
import { useSocketEvent } from "../../../lib/realtime.js";
import { openPanel } from "../../../workspace/index.js";
import ScanExperience from "./ScanExperience.jsx";
import ScanOutcome from "./ScanOutcome.jsx";
import ScanResult from "./ScanResult.jsx";
import { submitAttendance, vibrate } from "./scan.js";
import { invalidateAttendanceSummary } from "./summary.js";
import { scanErrorView } from "./view.js";

// One submission per (session, token) even when React StrictMode mounts the
// page twice: both mounts share the same promise.
const INFLIGHT = new Map();

const submitOnce = (sessionId, token) => {
  const key = `${sessionId}:${token}`;
  if (!INFLIGHT.has(key)) {
    INFLIGHT.set(
      key,
      submitAttendance({ sessionId, token }).then((result) => {
        vibrate(80);
        invalidateAttendanceSummary();
        return result;
      }),
    );
  }
  return INFLIGHT.get(key);
};

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b-2 border-black bg-white">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-black text-xs font-black text-white">{APP_INITIALS}</span>
          <span className="truncate text-sm font-black uppercase">{APP_NAME}</span>
        </div>
        <Link to="/" className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0 sm:py-1.5">
          OPEN APP
        </Link>
      </div>
    </header>
  );
}

const expiredView = (base) => ({
  ...base,
  title: "SCAN THE LIVE CODE AGAIN",
  message:
    "This QR code was already used or expired — it changes after every scan and every few seconds. Scan the code on the screen again with the in-app scanner.",
});

/**
 * `/attend?s=<sessionId>&t=<token>&v=<n>` — opened by the phone's native
 * camera. Submits once automatically (FRONTEND.md §5), then strips the token
 * from the URL so a reload never resubmits a spent code. No `s`/`t` → scanner.
 */
export default function AttendPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [initial] = useState(() => ({ sessionId: (searchParams.get("s") || "").trim(), token: (searchParams.get("t") || "").trim() }));
  const hasToken = Boolean(initial.sessionId && initial.token);
  const [attempt, setAttempt] = useState(null); // { status: "success"|"error", result?, error?, at? }
  const [scanning, setScanning] = useState(!hasToken);
  const urlCleanedRef = useRef(false);

  useEffect(() => {
    if (!hasToken) return undefined;
    let active = true;
    submitOnce(initial.sessionId, initial.token).then(
      (result) => {
        if (active) setAttempt({ status: "success", result });
      },
      (error) => {
        if (active) setAttempt((previous) => (previous?.status === "success" ? previous : { status: "error", error, at: Date.now() }));
      },
    );
    if (!urlCleanedRef.current) {
      urlCleanedRef.current = true;
      setSearchParams({ s: initial.sessionId }, { replace: true });
    }
    return () => {
      active = false;
    };
  }, [hasToken, initial, setSearchParams]);

  // If the HTTP answer is lost on a flaky network, the server still confirms on our socket.
  useSocketEvent(ATTENDANCE_EVENTS?.CONFIRMED ?? "attendance:confirmed", (payload) => {
    if (!hasToken || scanning || payload?.sessionId !== initial.sessionId || attempt?.status === "success") return;
    if (attempt?.status === "error" && attempt.error?.code !== "NETWORK") return;
    setAttempt({
      status: "success",
      result: { status: payload.status, markedAt: null, session: { _id: payload.sessionId }, course: payload.course ?? null, summary: null },
    });
  });

  const goToApp = (panel, params, data) => {
    if (panel) openPanel(panel, params, data ? { data } : undefined);
    navigate("/");
  };
  const openAttendance = () => goToApp("attendance.student");
  const joinCourse = () => goToApp("attendance.student", {}, { openJoin: true });

  let body;
  if (scanning) {
    body = (
      <section className="card-stark bg-white">
        <div className="mb-4 flex items-center gap-2 border-b-2 border-black pb-3">
          <ScanQrCode className="h-5 w-5" aria-hidden="true" />
          <h1 className="text-sm font-black uppercase">Scan the live QR</h1>
        </div>
        <ScanExperience
          initialTried={hasToken ? [initial.token] : []}
          onOpenAttendance={openAttendance}
          onJoinCourse={joinCourse}
          onDone={() => goToApp()}
          doneLabel="DONE"
        />
      </section>
    );
  } else if (!attempt) {
    body = (
      <section className="card-stark flex flex-col items-center gap-3 bg-white py-10 text-center" role="status" aria-live="polite">
        <LoaderCircle className="h-10 w-10 animate-spin" aria-hidden="true" />
        <div className="text-sm font-black uppercase">Marking your attendance…</div>
        <p className="text-[11px] font-semibold text-gray-600">Keep this page open for a second.</p>
      </section>
    );
  } else if (attempt.status === "success") {
    body = (
      <section className="card-stark bg-white py-6">
        <ScanResult result={attempt.result} onOpenAttendance={openAttendance} onDone={() => goToApp()} doneLabel="DONE" />
      </section>
    );
  } else {
    const base = scanErrorView(attempt.error);
    const view = base.code === "TOKEN_EXPIRED" ? expiredView(base) : base;
    body = (
      <section className="card-stark bg-white py-6">
        <ScanOutcome
          view={view}
          at={attempt.at}
          onRetry={() => setScanning(true)}
          retryLabel="SCAN AGAIN"
          onJoinCourse={joinCourse}
          onOpenAttendance={openAttendance}
          onDone={() => goToApp()}
        />
      </section>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[#f8fafc]">
      <Header />
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{body}</main>
    </div>
  );
}
