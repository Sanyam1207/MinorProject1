import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { LoaderCircle, Save } from "lucide-react";
import ErrorState from "../../ui/ErrorState.jsx";
import LoadingState from "../../ui/LoadingState.jsx";
import { toastError, toastSuccess } from "../../ui/toast.js";
import { useAsync } from "../../ui/useAsync.js";
import { needsHomeScreenInstall } from "./push.js";
import { disablePush, enablePush, loadPreferences, savePreferences } from "./thunks.js";

const CATEGORIES = [
  { prefix: "attendance.", label: "Attendance & classes" },
  { prefix: "placement.", label: "Drives, applications & offers" },
  { prefix: "training.", label: "Training programs" },
  { prefix: "jobfeed.", label: "Job feed matches" },
  { prefix: "system", label: "Account & system" },
];

function Toggle({ label, hint, checked, disabled, busy, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-200 py-2.5">
      <div className="min-w-0">
        <div className="text-xs font-black uppercase">{label}</div>
        {hint && <div className="text-[10px] font-semibold text-gray-500">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        className={`flex h-6 w-12 shrink-0 items-center border-2 border-black p-0.5 transition-colors disabled:opacity-50 ${checked ? "justify-end bg-black" : "justify-start bg-gray-200"}`}
      >
        <span className="flex h-4 w-4 items-center justify-center border border-black bg-white">
          {busy && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />}
        </span>
      </button>
    </div>
  );
}

function PreferencesForm({ initial }) {
  const dispatch = useDispatch();
  const push = useSelector((state) => state.notifications.push);
  const [email, setEmail] = useState(initial.email);
  const [pushAll, setPushAll] = useState(initial.push);
  const [muted, setMuted] = useState(() => new Set(initial.mutedTypes));
  const [saving, setSaving] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);

  const toggleMuted = (prefix) =>
    setMuted((current) => {
      const next = new Set(current);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await dispatch(savePreferences({ email, push: pushAll, mutedTypes: [...muted] }));
      toastSuccess("Notification preferences saved");
    } catch (error) {
      toastError(error, "Couldn't save your preferences");
    } finally {
      setSaving(false);
    }
  };

  const toggleDevice = async (enable) => {
    setDeviceBusy(true);
    try {
      if (enable) {
        await dispatch(enablePush());
        toastSuccess("Alerts are on for this device");
      } else {
        await dispatch(disablePush());
        toastSuccess("Alerts are off for this device");
      }
    } catch (error) {
      toastError(error, "Couldn't change alerts for this device");
    } finally {
      setDeviceBusy(false);
    }
  };

  const deviceHint = !push.supported
    ? needsHomeScreenInstall()
      ? "Add this app to your Home Screen to receive alerts."
      : "This browser can't receive push alerts here (https is required)."
    : push.serverEnabled === false
      ? "Push is not configured on the server."
      : push.permission === "denied"
        ? "Notifications are blocked for this site in your browser settings."
        : "Alerts on this phone or computer, even when the app is closed.";

  return (
    <div className="space-y-4">
      <div>
        <Toggle label="Email me" hint="Important updates by email" checked={email} onChange={setEmail} />
        <Toggle label="Push to my devices" hint="Allow push alerts on any device you enable" checked={pushAll} onChange={setPushAll} />
        <Toggle
          label="This device"
          hint={deviceHint}
          checked={push.subscribed}
          busy={deviceBusy}
          disabled={!push.supported || push.serverEnabled === false || (push.permission === "denied" && !push.subscribed)}
          onChange={toggleDevice}
        />
      </div>
      <fieldset className="border-2 border-black p-3">
        <legend className="px-1 text-[10px] font-black uppercase">Mute categories</legend>
        <div className="space-y-2">
          {CATEGORIES.map((category) => (
            <label key={category.prefix} className="flex min-h-9 cursor-pointer items-center gap-2 text-xs font-bold">
              <input
                type="checkbox"
                checked={muted.has(category.prefix)}
                onChange={() => toggleMuted(category.prefix)}
                className="h-4 w-4 accent-black"
              />
              {category.label}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="button" onClick={save} disabled={saving} className="btn-primary min-h-11 w-full justify-center py-2 text-xs disabled:opacity-60">
        {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
        SAVE PREFERENCES
      </button>
    </div>
  );
}

/** PREFERENCES tab (FRONTEND.md §9.5). */
export default function NotificationPreferences() {
  const dispatch = useDispatch();
  const query = useAsync(() => dispatch(loadPreferences()), [dispatch]);

  if (query.loading && !query.data) return <LoadingState label="LOADING PREFERENCES…" />;
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  return <PreferencesForm initial={query.data} />;
}
