import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { RefreshCw } from "lucide-react";
import { useNow } from "../../../ui/useNow.js";

/**
 * The rotating attendance QR (FRONTEND.md §13.1): a canvas drawn with
 * `QRCode.toCanvas` on every new token + a countdown bar to the token's
 * deadline. The canvas is drawn at `resolution` px and scaled by CSS to fill
 * its container (`className` sizes it), so it stays sharp on phones and projectors.
 */
export default function QrDisplay({ qr, deadline, resolution = 720, className = "", showMeta = true, dark = false }) {
  const canvasRef = useRef(null);
  const [drawError, setDrawError] = useState(null);
  const url = qr?.url ?? "";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    let cancelled = false;
    // qrcode writes a fixed pixel size into style; the canvas keeps its
    // intrinsic resolution and CSS scales it to the container.
    const fit = () => {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    };
    QRCode.toCanvas(canvas, url, { errorCorrectionLevel: "M", margin: 2, width: resolution }).then(
      () => {
        fit();
        if (!cancelled) setDrawError(null);
      },
      (error) => {
        if (!cancelled) setDrawError(error);
      },
    );
    fit();
    return () => {
      cancelled = true;
    };
  }, [url, resolution]);

  return (
    <div className={`flex flex-col items-stretch ${className}`}>
      <div className="relative aspect-square w-full border-[3px] border-black bg-white shadow-[4px_4px_0_0_#000]">
        {url ? (
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Attendance QR code"
            className="block h-full w-full"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
            <RefreshCw className="h-8 w-8 animate-spin" aria-hidden="true" />
            <span className="text-xs font-black uppercase">Waiting for the QR code…</span>
          </div>
        )}
        {drawError && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-4 text-center text-xs font-black uppercase">
            Couldn&apos;t draw the QR code. Refresh the page.
          </div>
        )}
      </div>
      {url && <Countdown qr={qr} deadline={deadline} showMeta={showMeta} dark={dark} />}
    </div>
  );
}

function Countdown({ qr, deadline, showMeta, dark }) {
  const now = useNow(1000);
  const rotationSeconds = Number(qr?.rotationSeconds) || 15;
  const leftMs = deadline ? Math.max(0, deadline - now) : 0;
  const seconds = Math.ceil(leftMs / 1000);
  const pct = Math.max(0, Math.min(100, (leftMs / (rotationSeconds * 1000)) * 100));
  return (
    <div className="mt-3">
      <div className={`h-2.5 border ${dark ? "border-white bg-gray-800" : "border-black bg-gray-100"}`} aria-hidden="true">
        <div
          className={`h-full transition-[width] duration-1000 ease-linear ${seconds <= 3 ? "bg-red-500" : dark ? "bg-white" : "bg-black"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showMeta && (
        <div className={`mt-1 flex items-center justify-between text-[10px] font-black uppercase tabular-nums ${dark ? "text-white" : ""}`}>
          <span>Code #{qr?.version ?? "—"}</span>
          <span aria-live="off">{seconds > 0 ? `Changes in ${seconds}s` : "Changing…"}</span>
        </div>
      )}
    </div>
  );
}
