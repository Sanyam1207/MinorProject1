import { LoaderCircle, MapPin, RefreshCw, ScanQrCode, TriangleAlert } from "lucide-react";
import QrScanner from "./QrScanner.jsx";
import ScanOutcome from "./ScanOutcome.jsx";
import ScanResult from "./ScanResult.jsx";
import { useScanFlow } from "./useScanFlow.js";

const NOTICES = {
  rotated: { Icon: RefreshCw, text: "QR just rotated — hold steady…", className: "bg-yellow-200", spin: true },
  "not-attendance": { Icon: TriangleAlert, text: "That's not an attendance QR. Aim at the code your teacher shows.", className: "bg-white" },
  "slow-down": { Icon: TriangleAlert, text: "Lots of tries — pausing a moment, keep pointing…", className: "bg-orange-100" },
  locating: { Icon: MapPin, text: "Checking your location…", className: "bg-blue-100" },
};

function StatusStrip({ phase, notice }) {
  if (phase === "submitting") {
    const locating = notice === "locating";
    return (
      <div className="flex items-center justify-center gap-2 border-t-2 border-black bg-black px-3 py-2.5 text-xs font-black uppercase text-white" role="status" aria-live="polite">
        {locating ? <MapPin className="h-4 w-4" aria-hidden="true" /> : <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {locating ? "Checking your location…" : "Marking you present…"}
      </div>
    );
  }
  const config = NOTICES[notice];
  if (!config) {
    return (
      <div className="flex items-center justify-center gap-2 border-t-2 border-black bg-white/95 px-3 py-2.5 text-[11px] font-black uppercase" role="status" aria-live="polite">
        <ScanQrCode className="h-4 w-4" aria-hidden="true" /> Point at the QR on the teacher's screen
      </div>
    );
  }
  const { Icon } = config;
  return (
    <div className={`flex items-center justify-center gap-2 border-t-2 border-black px-3 py-2.5 text-[11px] font-black uppercase ${config.className}`} role="status" aria-live="polite">
      <Icon className={`h-4 w-4 shrink-0 ${config.spin ? "animate-spin" : ""}`} aria-hidden="true" />
      <span>{config.text}</span>
    </div>
  );
}

/**
 * Camera + scan state machine + result, shared by ScanPanel and AttendPage.
 * The camera stays mounted (and running) through TOKEN_EXPIRED retries and is
 * released as soon as there is a final outcome.
 */
export default function ScanExperience({ initialTried, onOpenAttendance, onJoinCourse, onDone, doneLabel }) {
  const flow = useScanFlow({ initialTried });

  if (flow.phase === "done" && flow.outcome?.kind === "success") {
    return <ScanResult result={flow.outcome.result} onOpenAttendance={onOpenAttendance} onDone={onDone ?? flow.reset} doneLabel={onDone ? doneLabel : "SCAN ANOTHER"} />;
  }
  if (flow.phase === "done" && flow.outcome) {
    return (
      <ScanOutcome
        view={flow.outcome.view}
        at={flow.outcome.at}
        onRetry={flow.reset}
        onJoinCourse={onJoinCourse}
        onOpenAttendance={onOpenAttendance}
        onDone={onDone}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <QrScanner onDecode={flow.handleDecoded} paused={flow.phase !== "scanning"}>
        <StatusStrip phase={flow.phase} notice={flow.notice} />
      </QrScanner>
      <p className="text-center text-[11px] font-semibold text-gray-600">
        Hold your phone 30–60 cm from the screen. The code changes after every scan — the scanner keeps going until you're marked.
      </p>
    </div>
  );
}
