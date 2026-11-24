import { useState } from "react";
import { ScanQrCode, Smartphone } from "lucide-react";
import { Panel } from "../../../ui/index.js";
import { openPanel } from "../../../workspace/index.js";
import ScanExperience from "./ScanExperience.jsx";

/** `attendance.scan` — in-app QR scanner (FRONTEND.md §13.2). */
export default function ScanPanel() {
  const [round, setRound] = useState(0);

  return (
    <Panel title="Scan attendance QR" icon={ScanQrCode} badge="LIVE CLASS" className="mx-auto w-full max-w-2xl">
      <ScanExperience
        key={round}
        onOpenAttendance={() => openPanel("attendance.student")}
        onJoinCourse={() => openPanel("attendance.student", {}, { data: { openJoin: true } })}
        onDone={() => setRound((value) => value + 1)}
        doneLabel="SCAN ANOTHER"
      />
      <div className="mt-4 flex items-start gap-2 border-t-[1.5px] border-black pt-3">
        <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-[11px] font-semibold text-gray-600">
          Camera not working here? Open your phone's camera app and point it at the QR — the link opens this app and marks you automatically.
        </p>
      </div>
    </Panel>
  );
}
