import { useState } from "react";
import { KeyRound, LoaderCircle, LogOut } from "lucide-react";
import { changePassword, storeAccessToken } from "../../lib/api/auth.js";
import { errorMessage } from "../../lib/http.js";
import Modal from "../../ui/Modal.jsx";
import { toastSuccess } from "../../ui/toast.js";

const MIN_LENGTH = 8;

/**
 * Change password (AUTH-FACULTY.md §5.4, §14.7). `forced` (first sign-in with a
 * temporary password) cannot be dismissed — the only way out is "Sign out".
 */
export default function ChangePasswordModal({ user, forced = false, onClose, onChanged, onSignOut }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const temporary = Boolean(user?.mustChangePassword);

  const submit = async (event) => {
    event.preventDefault();
    if (next.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (next !== confirm) return setError("The new passwords don't match.");
    if (current && current === next) return setError("Choose a password different from the current one.");
    setSaving(true);
    setError(null);
    try {
      const result = await changePassword({ currentPassword: current || undefined, newPassword: next });
      if (result.accessToken) storeAccessToken(result.accessToken);
      toastSuccess("Password changed");
      onChanged?.(result.user);
    } catch (requestError) {
      setSaving(false);
      if (requestError?.code === "INVALID_CURRENT_PASSWORD") setError(temporary ? "The temporary password is incorrect." : "Your current password is incorrect.");
      else if (requestError?.status === 404) setError("Changing your password isn't available on this server yet.");
      else setError(errorMessage(requestError, "Couldn't change the password. Try again."));
    }
    return undefined;
  };

  return (
    <Modal
      open
      size="sm"
      title={forced ? "SET A NEW PASSWORD TO CONTINUE" : "CHANGE PASSWORD"}
      onClose={forced ? undefined : onClose}
      footer={
        <>
          {forced ? (
            <button type="button" onClick={onSignOut} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> SIGN OUT
            </button>
          ) : (
            <button type="button" onClick={onClose} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              CANCEL
            </button>
          )}
          <button type="submit" form="change-password-form" disabled={saving} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
            SAVE PASSWORD
          </button>
        </>
      }
    >
      <form id="change-password-form" onSubmit={submit} className="space-y-3">
        {forced && (
          <p className="border-2 border-black bg-yellow-50 p-2 text-[11px] font-bold">
            Your account uses a temporary password. Choose your own password to continue.
          </p>
        )}
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold uppercase">{temporary ? "Temporary password" : "Current password"}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="input-stark w-full font-mono text-base sm:text-xs"
          />
          <span className="mt-1 block text-[10px] font-semibold text-gray-500">Leave empty if you only sign in with Google.</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold uppercase">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_LENGTH}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className="input-stark w-full font-mono text-base sm:text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold uppercase">Confirm new password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="input-stark w-full font-mono text-base sm:text-xs"
          />
        </label>
        {error && (
          <p role="alert" className="border-2 border-black bg-red-100 p-2 text-[11px] font-bold">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
