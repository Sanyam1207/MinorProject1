import { useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle, Mail } from "lucide-react";
import { forgotPassword } from "../../lib/api/auth.js";
import { errorMessage } from "../../lib/http.js";

const GENERIC_SENT = "If an account exists for that email, a reset link has been sent.";

/** Email → reset link. Always answers with the generic message (no account enumeration). */
export default function ForgotPasswordForm({ defaultEmail = "", onBack }) {
  const [email, setEmail] = useState(defaultEmail);
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setError(null);
    try {
      await forgotPassword(email);
      setStatus("sent");
    } catch (requestError) {
      if (requestError?.code === "EMAIL_NOT_CONFIGURED" || requestError?.status === 503) {
        setError(errorMessage(requestError, "Password reset by email isn't available. Ask your placement office (TPO) to reset your password."));
      } else if (requestError?.code === "TOO_MANY_ATTEMPTS" || requestError?.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
      } else if (requestError?.code === "VALIDATION") {
        setError("Enter a valid email address.");
      } else if (requestError?.status === 0) {
        setError(errorMessage(requestError, "Cannot reach the server. Check your connection."));
      } else {
        // Never reveal whether the account exists.
        setStatus("sent");
        return;
      }
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <div className="space-y-3 border-2 border-black bg-green-50 p-4 text-xs font-semibold" role="status">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700" aria-hidden="true" />
          <p>{GENERIC_SENT} The link expires soon, so open it on this device.</p>
        </div>
        {onBack && (
          <button type="button" onClick={onBack} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> BACK TO SIGN IN
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-2 border-black bg-gray-50 p-4">
      <div className="text-xs font-black uppercase">Reset your password</div>
      <label className="block">
        <span className="mb-1 block text-[10px] font-extrabold uppercase">Account email</span>
        <span className="relative flex items-center">
          <Mail className="pointer-events-none absolute left-3 h-4 w-4 text-gray-500" aria-hidden="true" />
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="input-stark w-full pl-9 font-mono text-base sm:text-xs"
            placeholder="you@college.edu"
          />
        </span>
      </label>
      {error && (
        <p role="alert" className="border-2 border-black bg-red-100 p-2 text-[11px] font-bold">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={status === "sending"} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-60 sm:min-h-0">
          {status === "sending" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          SEND RESET LINK
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            CANCEL
          </button>
        )}
      </div>
    </form>
  );
}
