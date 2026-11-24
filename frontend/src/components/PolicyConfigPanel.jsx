import { useState } from "react";
import { LoaderCircle, RotateCcw, Save, Settings } from "lucide-react";
import { getPlacementPolicy, savePlacementPolicy } from "../lib/api/admin.js";
import { DEFAULT_POLICY, academicYearOf, isValidAcademicYear, validatePolicy } from "../features/tpo/mappers.js";
import { Notice } from "../features/tpo/parts.jsx";
import { ErrorState, Field, LoadingState, Panel, formatDateTime, toastError, toastSuccess, useAsync } from "../ui/index.js";
import { usePanel } from "../workspace/index.js";

const inputClass = "input-stark w-full text-base font-bold sm:text-sm";

function ToggleRow({ label, description, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-xs font-black uppercase">{label}</div>
        <p className="mt-0.5 text-[10px] text-gray-600">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-12 shrink-0 border-2 border-black transition-colors ${checked ? "bg-black" : "bg-white"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 border border-black transition-all ${checked ? "left-6 bg-white" : "left-0.5 bg-black"}`} />
      </button>
    </div>
  );
}

function PolicyEditor({ initial, onSaved, onReload }) {
  const [policy, setPolicy] = useState(initial);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);
  const update = (key, value) => setPolicy((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(policy) !== JSON.stringify(initial);

  const save = async () => {
    const found = validatePolicy(policy);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const saved = await savePlacementPolicy(policy);
      toastSuccess(`Policy for ${saved?.academicYear ?? policy.academicYear} saved and active`);
      onSaved(saved);
    } catch (failure) {
      const field = failure?.details?.field;
      if (field) setErrors((current) => ({ ...current, [field]: failure.message }));
      setServerError(failure?.message || "Could not save the policy");
      toastError(failure, "Could not save the policy");
    } finally {
      setSaving(false);
    }
  };

  const numberField = (key, label, hint, attrs) => (
    <Field label={label} hint={hint} error={errors[key]}>
      <input
        type="number"
        inputMode="decimal"
        value={policy[key] ?? ""}
        onChange={(event) => update(key, event.target.value === "" ? "" : Number(event.target.value))}
        className={inputClass}
        {...attrs}
      />
    </Field>
  );

  const dream = Number(policy.dreamMultiplier) || DEFAULT_POLICY.dreamMultiplier;
  const superDream = Number(policy.superDreamMultiplier) || DEFAULT_POLICY.superDreamMultiplier;

  return (
    <div className="space-y-4">
      {initial.isDefault && <Notice tone="warn">No policy saved yet — showing defaults. Save to make it the active policy for {initial.academicYear}.</Notice>}
      {serverError && <Notice tone="error">{serverError}</Notice>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Academic year *" hint="The policy is activated for this academic year." error={errors.academicYear}>
          <input value={policy.academicYear ?? ""} onChange={(event) => update("academicYear", event.target.value.trim())} placeholder="2026-27" className={inputClass} />
        </Field>
        {numberField("offerExpiryDays", "Offer expiry (days)", "Students must respond within this many days.", { min: 1, max: 30, step: 1 })}
        {numberField("maxPendingOffers", "Max pending offers per student", "Unanswered offers a student may hold at once.", { min: 1, max: 10, step: 1 })}
        {numberField("dreamMultiplier", "Dream multiplier (×)", "Upgrade allowed when new offer ≥ current × this.", { min: 1.1, max: 5, step: 0.1 })}
        {numberField("superDreamMultiplier", "Super-dream multiplier (×)", "Offers at or above this are super-dream.", { min: 1.5, max: 10, step: 0.1 })}
      </div>
      <div className="space-y-4 border-t-2 border-black pt-4">
        <ToggleRow
          label="Enforce one offer per student"
          description="A student who accepted an offer can only accept another that meets the dream threshold."
          checked={Boolean(policy.enforceOneOffer)}
          onChange={(value) => update("enforceOneOffer", value)}
        />
        <ToggleRow
          label="Allow dream upgrades"
          description="Accepting a dream offer releases the earlier accepted offer."
          checked={Boolean(policy.allowDreamUpgrade)}
          onChange={(value) => update("allowDreamUpgrade", value)}
        />
      </div>
      <div className="border-2 border-black bg-gray-50 p-3 text-xs font-medium text-gray-800">
        <div className="mb-1 text-[11px] font-black uppercase">Preview</div>
        <p>• One-offer rule: <b>{policy.enforceOneOffer ? "ON" : "OFF"}</b> · dream upgrades: <b>{policy.allowDreamUpgrade ? "ON" : "OFF"}</b></p>
        <p>• A student holding 10 LPA may accept a dream offer of at least <b>{(10 * dream).toFixed(1)} LPA</b>; super-dream from <b>{(10 * superDream).toFixed(1)} LPA</b>.</p>
      </div>
      {initial.updatedAt && !initial.isDefault && (
        <p className="text-[10px] font-semibold text-gray-600">Last saved {formatDateTime(initial.updatedAt)}{initial.updatedBy?.name ? ` by ${initial.updatedBy.name}` : ""}.</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onReload} disabled={saving} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> DISCARD CHANGES
        </button>
        <button type="button" onClick={save} disabled={saving || (!dirty && !initial.isDefault)} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
          {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />} SAVE POLICY
        </button>
      </div>
    </div>
  );
}

/** Placement policy (`tpo.policy`): GET/PUT /offers/policy. */
export default function PolicyConfigPanel() {
  const { params } = usePanel("tpo.policy");
  const academicYear = isValidAcademicYear(params.academicYear) ? params.academicYear : undefined;
  const [version, setVersion] = useState(0);
  const { data, error, loading, reload, setData } = useAsync(async () => {
    try {
      return await getPlacementPolicy({ academicYear });
    } catch (failure) {
      // No policy endpoint / nothing saved: fall back to defaults WITH a visible notice.
      if (failure?.status === 404) return null;
      throw failure;
    }
  }, [academicYear]);

  const initial = data
    ? { ...DEFAULT_POLICY, ...data, academicYear: data.academicYear || academicYear || academicYearOf() }
    : { ...DEFAULT_POLICY, academicYear: academicYear || academicYearOf(), isDefault: true };

  return (
    <Panel title="Placement policy" icon={Settings} badge={initial.academicYear ? `AY ${initial.academicYear}` : undefined}>
      {loading && data === undefined ? (
        <LoadingState label="LOADING POLICY…" />
      ) : error && data === undefined ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <PolicyEditor
          key={`${initial._id ?? "default"}:${initial.updatedAt ?? ""}:${version}`}
          initial={initial}
          onSaved={(saved) => {
            setData(saved);
            setVersion((value) => value + 1);
          }}
          onReload={() => {
            setVersion((value) => value + 1);
            reload();
          }}
        />
      )}
    </Panel>
  );
}
