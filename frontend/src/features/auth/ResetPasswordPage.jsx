import { useState } from "react";
import { useDispatch } from "react-redux";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, KeyRound, LoaderCircle, TriangleAlert } from "lucide-react";
import { checkResetToken, resetPassword } from "../../lib/api/auth.js";
import { APP_INITIALS, APP_NAME } from "../../lib/config.js";
import { errorMessage } from "../../lib/http.js";
import LoadingState from "../../ui/LoadingState.jsx";
import { useAsync } from "../../ui/useAsync.js";
import { logout } from "./session.js";
import { useSession } from "./useSession.js";

const INVALID_LINK = "This link is invalid or has expired. Ask for a new one.";
const MIN_LENGTH = 8;

/** `/reset-password/:token[?invite=1]` — public (FRONTEND.md §5, AUTH-FACULTY.md §5.3). */
export default function ResetPasswordPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const [searchParams] = useSearchParams();
  const isInvite = searchParams.get("invite") === "1";
  const { isAuthenticated } = useSession();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState("idle"); // idle | saving | done
  const [error, setError] = useState(null);

  // GET does not consume the token; a server without the GET route (404) still gets the form.
  const tokenCheck = useAsync(() => checkResetToken(token), [token]);
  const linkInvalid = !token || tokenCheck.error?.code === "RESET_TOKEN_INVALID" || tokenCheck.error?.status === 400;

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;

  const submit = async (event) => {
    event.preventDefault();
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== confirm) return setError("The passwords don't match.");
    setStatus("saving");
    setError(null);
    try {
      await resetPassword(token, password);
      setStatus("done");
    } catch (requestError) {
      setStatus("idle");
      if (requestError?.code === "RESET_TOKEN_INVALID" || (requestError?.status === 400 && requestError?.code !== "WEAK_PASSWORD")) {
        setError(INVALID_LINK);
      } else if (requestError?.code === "WEAK_PASSWORD") {
        setError(errorMessage(requestError, `Use at least ${MIN_LENGTH} characters.`));
      } else {
        setError(errorMessage(requestError, "Couldn't update the password. Try again."));
      }
    }
    return undefined;
  };

  const goToSignIn = async () => {
    // Resetting a password revokes every session of that account.
    if (isAuthenticated) await dispatch(logout());
    navigate("/", { replace: true });
  };

  const heading = isInvite ? "ACTIVATE YOUR FACULTY ACCOUNT" : "SET A NEW PASSWORD";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#f8fafc] p-4 text-black">
      <div className="card-stark w-full max-w-md space-y-5 border-2 border-black p-5 shadow-bold-lg sm:p-6">
        <div className="space-y-1.5 border-b-2 border-black pb-4 text-center">
          <div className="mb-1 inline-block border-2 border-black bg-black px-3 py-1 text-2xl font-black text-white">{APP_INITIALS}</div>
          <h1 className="text-lg font-extrabold uppercase tracking-tight">{heading}</h1>
          <p className="text-xs font-semibold text-gray-600">{APP_NAME}</p>
        </div>

        {tokenCheck.loading ? (
          <LoadingState label="CHECKING YOUR LINK…" />
        ) : status === "done" ? (
          <div className="space-y-4 text-center" role="status">
            <CheckCircle2 className="mx-auto h-9 w-9 text-green-700" aria-hidden="true" />
            <div className="text-sm font-black uppercase">Password updated</div>
            <p className="text-xs font-semibold text-gray-600">Sign in with your new password.</p>
            <button type="button" onClick={goToSignIn} className="btn-primary min-h-11 w-full justify-center py-2 text-xs">
              SIGN IN
            </button>
          </div>
        ) : linkInvalid ? (
          <div className="space-y-4 text-center" role="alert">
            <TriangleAlert className="mx-auto h-9 w-9 text-red-700" aria-hidden="true" />
            <p className="text-xs font-bold">{INVALID_LINK}</p>
            <button type="button" onClick={goToSignIn} className="btn-secondary min-h-11 w-full justify-center py-2 text-xs">
              BACK TO SIGN IN
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {tokenCheck.data?.email && (
              <p className="border-2 border-black bg-gray-50 p-2 text-center font-mono text-xs">{tokenCheck.data.email}</p>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-extrabold uppercase">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_LENGTH}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="input-stark w-full font-mono text-base sm:text-xs"
              />
              {tooShort && <span className="mt-1 block text-[10px] font-bold text-red-700">At least {MIN_LENGTH} characters.</span>}
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-extrabold uppercase">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className="input-stark w-full font-mono text-base sm:text-xs"
              />
              {mismatch && <span className="mt-1 block text-[10px] font-bold text-red-700">The passwords don&apos;t match.</span>}
            </label>
            {error && (
              <p role="alert" className="border-2 border-black bg-red-100 p-2 text-[11px] font-bold">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={status === "saving" || mismatch || password.length < MIN_LENGTH}
              className="btn-primary min-h-11 w-full justify-center py-2.5 text-xs disabled:opacity-50"
            >
              {status === "saving" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
              {isInvite ? "ACTIVATE ACCOUNT" : "UPDATE PASSWORD"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
