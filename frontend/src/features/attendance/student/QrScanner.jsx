import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Flashlight, FlashlightOff, RotateCcw, ShieldAlert, Smartphone } from "lucide-react";
import { isCameraSupported, isSecureOrigin } from "./scan.js";

const DECODE_INTERVAL_MS = 110;
const MAX_DECODE_WIDTH = 640;

let jsQRPromise = null;
const loadJsQR = () => {
  if (!jsQRPromise) {
    jsQRPromise = import("jsqr").then((module) => module.default ?? module).catch((error) => {
      jsQRPromise = null;
      throw error;
    });
  }
  return jsQRPromise;
};

const cameraErrorKind = (error) => {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "failed";
};

const CAMERA_ERRORS = {
  denied: {
    title: "CAMERA ACCESS IS BLOCKED",
    text: "Allow camera access for this site (tap the lock / ⓘ icon next to the address, then Camera → Allow) and tap TRY AGAIN. Or scan the QR with your phone's camera app instead.",
  },
  missing: { title: "NO CAMERA FOUND", text: "This device has no usable camera. Scan the QR with your phone's camera app instead." },
  busy: { title: "CAMERA IS BUSY", text: "Another app or tab is using the camera. Close it and tap TRY AGAIN, or scan with your phone's camera app." },
  failed: { title: "COULDN'T START THE CAMERA", text: "Tap TRY AGAIN, or scan the QR with your phone's camera app instead." },
  insecure: {
    title: "THE IN-APP SCANNER NEEDS HTTPS",
    text: "Your browser only allows the camera on secure (https) pages. Open your phone's camera app and point it at the QR — the link opens this app and marks you automatically.",
  },
};

function CameraHelp({ kind, onRetry }) {
  const copy = CAMERA_ERRORS[kind] ?? CAMERA_ERRORS.failed;
  const Icon = kind === "insecure" ? ShieldAlert : CameraOff;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border-2 border-black bg-yellow-100 p-5 text-center">
      <Icon className="h-8 w-8" aria-hidden="true" />
      <div className="text-xs font-black uppercase">{copy.title}</div>
      <p className="max-w-sm text-[11px] font-semibold text-gray-800">{copy.text}</p>
      <div className="flex w-full max-w-sm items-start gap-2 border-[1.5px] border-black bg-white p-3 text-left">
        <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-[11px] font-semibold">
          <span className="font-black uppercase">Tip:</span> the phone camera app works everywhere — open it, aim at the code, tap the link that pops up.
        </p>
      </div>
      {onRetry && kind !== "insecure" && kind !== "missing" && (
        <button type="button" onClick={onRetry} className="btn-primary min-h-11 px-4 text-xs">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> TRY AGAIN
        </button>
      )}
    </div>
  );
}

/**
 * In-app QR scanner: rear camera via getUserMedia, jsQR decoding on a
 * downscaled canvas inside a requestAnimationFrame loop. Calls `onDecode(text)`
 * for every decoded frame (the caller de-duplicates). `paused` keeps the
 * camera running but skips decoding.
 */
export default function QrScanner({ onDecode, paused = false, children }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const trackRef = useRef(null);
  const onDecodeRef = useRef(onDecode);
  const pausedRef = useRef(paused);
  const [attempt, setAttempt] = useState(0);
  const [camera, setCamera] = useState({ attempt: -1, status: "starting", error: null, torch: false });
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    onDecodeRef.current = onDecode;
    pausedRef.current = paused;
  }, [onDecode, paused]);

  const supported = isCameraSupported();
  const secure = isSecureOrigin();

  useEffect(() => {
    if (!supported) return undefined;
    const videoElement = videoRef.current;
    let cancelled = false;
    let frame = 0;
    let stream = null;
    let lastDecode = 0;
    let decoder = null;

    const tick = (time) => {
      if (cancelled) return;
      frame = requestAnimationFrame(tick);
      const video = videoElement;
      const canvas = canvasRef.current;
      if (!decoder || !video || !canvas || pausedRef.current) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (time - lastDecode < DECODE_INTERVAL_MS) return;
      lastDecode = time;
      const scale = Math.min(1, MAX_DECODE_WIDTH / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      let result;
      try {
        const image = context.getImageData(0, 0, width, height);
        result = decoder(image.data, width, height, { inversionAttempts: "dontInvert" });
      } catch {
        return;
      }
      if (result?.data) onDecodeRef.current?.(result.data);
    };

    Promise.all([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      }),
      loadJsQR(),
    ])
      .then(async ([mediaStream, jsQR]) => {
        stream = mediaStream;
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        decoder = jsQR;
        const video = videoElement;
        if (video) {
          video.srcObject = mediaStream;
          try {
            await video.play();
          } catch {
            // autoplay is allowed for muted inline video; ignore spurious aborts
          }
        }
        if (cancelled) return;
        const [track] = mediaStream.getVideoTracks();
        trackRef.current = track ?? null;
        let torch;
        try {
          torch = Boolean(track?.getCapabilities?.().torch);
        } catch {
          torch = false;
        }
        setCamera({ attempt, status: "ready", error: null, torch });
        frame = requestAnimationFrame(tick);
      })
      .catch((error) => {
        stream?.getTracks().forEach((track) => track.stop());
        if (!cancelled) setCamera({ attempt, status: "error", error: cameraErrorKind(error), torch: false });
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
      if (videoElement) videoElement.srcObject = null;
    };
  }, [attempt, supported]);

  const toggleTorch = () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next }] })
      .then(() => setTorchOn(next))
      .catch(() => setCamera((previous) => ({ ...previous, torch: false })));
  };

  const retry = () => {
    setTorchOn(false);
    setAttempt((value) => value + 1);
  };

  if (!supported) return <CameraHelp kind={secure ? "missing" : "insecure"} />;

  const current = camera.attempt === attempt ? camera : { status: "starting", error: null, torch: false };
  if (current.status === "error") return <CameraHelp kind={current.error} onRetry={retry} />;

  return (
    <div className="relative mx-auto aspect-square w-full max-w-md overflow-hidden border-2 border-black bg-black shadow-[4px_4px_0_0_#000]">
      <video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay aria-label="Camera preview" />
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      {/* Aiming frame */}
      <div className="pointer-events-none absolute inset-[12%]" aria-hidden="true">
        <span className="absolute left-0 top-0 h-8 w-8 border-l-4 border-t-4 border-white" />
        <span className="absolute right-0 top-0 h-8 w-8 border-r-4 border-t-4 border-white" />
        <span className="absolute bottom-0 left-0 h-8 w-8 border-b-4 border-l-4 border-white" />
        <span className="absolute bottom-0 right-0 h-8 w-8 border-b-4 border-r-4 border-white" />
      </div>

      {current.status === "starting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-white">
          <Camera className="h-8 w-8 animate-pulse" aria-hidden="true" />
          <span className="text-xs font-black uppercase">Starting camera…</span>
          <span className="px-6 text-center text-[11px] font-semibold text-gray-300">Allow camera access if your browser asks.</span>
        </div>
      )}

      {current.torch && (
        <button
          type="button"
          onClick={toggleTorch}
          aria-pressed={torchOn}
          className={`absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center border-2 border-black ${torchOn ? "bg-yellow-200" : "bg-white"}`}
          aria-label={torchOn ? "Turn the flashlight off" : "Turn the flashlight on"}
        >
          {torchOn ? <FlashlightOff className="h-5 w-5" aria-hidden="true" /> : <Flashlight className="h-5 w-5" aria-hidden="true" />}
        </button>
      )}

      {children && <div className="absolute inset-x-0 bottom-0">{children}</div>}
    </div>
  );
}
