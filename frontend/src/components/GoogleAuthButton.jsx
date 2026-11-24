import { useState } from "react";
import { useDispatch } from "react-redux";
import { GoogleLogin } from "@react-oauth/google";
import { LoaderCircle } from "lucide-react";
import { googleLogin } from "../lib/api/auth.js";
import { GOOGLE_CLIENT_ID } from "../lib/config.js";
import { completeLogin } from "../features/auth/session.js";

/**
 * Google Identity Services sign-in (FRONTEND.md §6.4). Renders nothing when
 * VITE_GOOGLE_CLIENT_ID is empty (main.jsx then mounts no GoogleOAuthProvider).
 * The ID token is verified by the server; there is no client-side fallback.
 */
export default function GoogleAuthButton({ role = "student", onSuccess, onError }) {
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);

  if (!GOOGLE_CLIENT_ID) return null;

  const handleCredential = async ({ credential } = {}) => {
    if (!credential) {
      onError?.(new Error("Google sign-in was cancelled or failed."));
      return;
    }
    setBusy(true);
    try {
      const session = await googleLogin({ credential, role });
      const user = await dispatch(completeLogin(session));
      onSuccess?.(user, session);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-2">
      {busy ? (
        <div className="flex w-full items-center justify-center gap-2 border-2 border-black bg-yellow-100 p-3 text-xs font-black uppercase">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Verifying Google account…
        </div>
      ) : (
        <GoogleLogin
          onSuccess={handleCredential}
          onError={() => onError?.(new Error("Google sign-in was cancelled or failed."))}
          useOneTap={false}
          theme="outline"
          size="large"
          shape="square"
          text="continue_with"
        />
      )}
    </div>
  );
}
