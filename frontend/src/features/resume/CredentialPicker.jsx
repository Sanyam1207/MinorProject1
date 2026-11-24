import { useState } from "react";
import { KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import { toastError } from "../../ui/index.js";
import { listProviderModels } from "../../lib/api/llm.js";

/**
 * Saved BYOK key + model picker. Keys are never typed here — only chosen from
 * the saved, masked credentials. No credentials → link to settings.ai-keys.
 */
export default function CredentialPicker({
  credentials = [],
  credentialId,
  onCredentialChange,
  model,
  onModelChange,
  onManageKeys,
  loading = false,
  disabled = false,
}) {
  const [loaded, setLoaded] = useState({ credentialId: null, models: [] });
  const [busy, setBusy] = useState(false);
  const selected = credentials.find((item) => item.id === credentialId) ?? null;
  const loadedModels = loaded.credentialId === credentialId ? loaded.models : [];
  const modelOptions = [...new Set([model, selected?.model, ...loadedModels].filter(Boolean))];

  const loadModels = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await listProviderModels(selected.provider, { credentialId: selected.id });
      setLoaded({ credentialId: selected.id, models: result.models });
    } catch (error) {
      toastError(error, "Could not load models for this key");
    } finally {
      setBusy(false);
    }
  };

  if (!loading && credentials.length === 0) {
    return (
      <div className="border-2 border-dashed border-gray-400 bg-gray-50 p-3 text-[11px] font-semibold">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> No AI key saved
        </div>
        Tailoring uses your own OpenAI, Anthropic, Google or xAI key.
        {onManageKeys && (
          <button type="button" onClick={onManageKeys} className="btn-primary mt-2 px-2 py-1 text-[10px]">
            ADD AN AI KEY
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
      <label className="block min-w-0">
        <span className="mb-1 flex items-center justify-between text-[10px] font-black uppercase tracking-wide">
          AI key
          {onManageKeys && (
            <button type="button" onClick={onManageKeys} className="text-[9px] font-black underline">
              MANAGE
            </button>
          )}
        </span>
        <select
          value={credentialId || ""}
          disabled={disabled || loading}
          onChange={(event) => {
            const next = credentials.find((item) => item.id === event.target.value) ?? null;
            onCredentialChange?.(next?.id ?? null, next);
          }}
          className="input-stark w-full min-w-0 truncate text-base sm:text-xs disabled:opacity-50"
        >
          <option value="">{loading ? "Loading keys…" : "Choose a saved key"}</option>
          {credentials.map((item) => (
            <option key={item.id} value={item.id}>
              {item.providerLabel} · {item.label} · {item.maskedApiKey}
              {item.broken ? " · NEEDS ATTENTION" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="block min-w-0">
        <span className="mb-1 flex items-center justify-between text-[10px] font-black uppercase tracking-wide">
          Model
          <button
            type="button"
            onClick={loadModels}
            disabled={!selected || busy}
            className="inline-flex items-center gap-1 text-[9px] font-black underline disabled:no-underline disabled:opacity-40"
          >
            {busy ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
            LOAD MODELS
          </button>
        </span>
        <select
          value={model || selected?.model || ""}
          disabled={disabled || !selected}
          onChange={(event) => onModelChange?.(event.target.value)}
          className="input-stark w-full min-w-0 truncate font-mono text-base sm:text-xs disabled:opacity-50"
        >
          {!modelOptions.length && <option value="">Default model</option>}
          {modelOptions.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
