import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Link2, RefreshCw } from "lucide-react";
import { api } from "../lib/api.js";

// Reads an axios error's response body as text, even when the request used responseType: "blob".
async function extractErrorMessage(err, fallback) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      return parsed?.message || fallback;
    } catch {
      return fallback;
    }
  }
  return data?.message || err?.message || fallback;
}

/** GGSIPU academic sync (enrollment + portal password + captcha). Behaviour unchanged. */
export default function GgsipuConnect({ onConnected }) {
  const [captchaUrl, setCaptchaUrl] = useState(null);
  const [captchaLoading, setCaptchaLoading] = useState(true);
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [enrollment, setEnrollment] = useState("");
  const [ggsipuPassword, setGgsipuPassword] = useState("");
  const [captchaText, setCaptchaText] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const captchaUrlRef = useRef(null);

  // Loads a captcha on mount and whenever the nonce changes; state is only set after the request settles.
  useEffect(() => {
    let active = true;
    api
      .getGgsipuCaptcha()
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        if (captchaUrlRef.current) URL.revokeObjectURL(captchaUrlRef.current);
        captchaUrlRef.current = url;
        setCaptchaUrl(url);
        setCaptchaLoading(false);
      })
      .catch(async (err) => {
        const message = await extractErrorMessage(err, "Failed to load GGSIPU captcha.");
        if (!active) return;
        setError(message);
        setCaptchaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [captchaNonce]);

  useEffect(
    () => () => {
      if (captchaUrlRef.current) URL.revokeObjectURL(captchaUrlRef.current);
    },
    [],
  );

  const reloadCaptcha = () => {
    setCaptchaLoading(true);
    setError(null);
    setCaptchaNonce((value) => value + 1);
  };

  const handleConnect = async (event) => {
    event.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      const data = await api.connectGgsipu({ enrollment: enrollment.trim(), password: ggsipuPassword, captcha: captchaText });
      setSuccess(true);
      setGgsipuPassword("");
      setCaptchaText("");
      onConnected?.(data?.data?.user);
    } catch (err) {
      setError(await extractErrorMessage(err, "GGSIPU connection failed. Please check your details."));
      setCaptchaText("");
      setCaptchaLoading(true);
      setCaptchaNonce((value) => value + 1);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <form onSubmit={handleConnect} className="space-y-2.5">
      {error && (
        <div className="flex items-start gap-1.5 border-[1.5px] border-black bg-red-100 p-2 text-[11px] font-bold text-black">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden="true" />
          <div>{error}</div>
        </div>
      )}

      {success && !error && (
        <div className="flex items-center gap-1.5 border-[1.5px] border-black bg-green-100 p-2 text-[11px] font-bold text-black">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-700" aria-hidden="true" />
          <div>Academic record synced from GGSIPU.</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-extrabold uppercase">Enrollment number</span>
          <input
            type="text"
            inputMode="numeric"
            value={enrollment}
            onChange={(event) => setEnrollment(event.target.value)}
            required
            placeholder="011234567890"
            className="input-stark w-full font-mono text-base sm:text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-extrabold uppercase">GGSIPU portal password</span>
          <input
            type="password"
            value={ggsipuPassword}
            onChange={(event) => setGgsipuPassword(event.target.value)}
            required
            className="input-stark w-full font-mono text-base sm:text-xs"
          />
        </label>
      </div>

      <div className="flex items-end gap-2.5">
        <div className="shrink-0">
          <span className="mb-1 block text-[10px] font-extrabold uppercase">Captcha</span>
          <div className="flex items-center gap-1.5">
            <div className="flex h-9 w-28 items-center justify-center overflow-hidden border-[1.5px] border-black bg-gray-100">
              {captchaLoading ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-gray-500" aria-hidden="true" />
              ) : captchaUrl ? (
                <img src={captchaUrl} alt="GGSIPU captcha" className="h-full w-full object-contain" />
              ) : (
                <span className="text-[9px] text-gray-500">N/A</span>
              )}
            </div>
            <button type="button" onClick={reloadCaptcha} disabled={captchaLoading} aria-label="Refresh captcha" className="btn-secondary p-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${captchaLoading ? "animate-spin" : ""}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        <label className="block flex-1">
          <span className="mb-1 block text-[10px] font-extrabold uppercase">Captcha text</span>
          <input
            type="text"
            value={captchaText}
            onChange={(event) => setCaptchaText(event.target.value)}
            required
            autoComplete="off"
            className="input-stark w-full font-mono text-base sm:text-xs"
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={connecting || captchaLoading || !captchaUrl}
        className="btn-primary min-h-11 w-full justify-center py-2 text-xs font-extrabold tracking-wider disabled:opacity-60 sm:min-h-0"
      >
        {connecting ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <>
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>CONNECT & SYNC FROM GGSIPU</span>
          </>
        )}
      </button>
    </form>
  );
}
