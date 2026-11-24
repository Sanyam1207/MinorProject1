import { useState } from "react";
import { KeyRound, LoaderCircle, PencilLine, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { ConfirmDialog, EmptyState, ErrorState, Field, LoadingState, Panel, formatDate, toastError, toastSuccess } from "../../ui/index.js";
import { usePanel } from "../../workspace/index.js";
import { deleteLlmCredential, listProviderModels, saveLlmCredential, updateLlmCredential } from "../../lib/api/llm.js";
import { useLlmCredentials } from "./hooks.js";

/** Inline editor for one saved key: rename + model (models loaded with the saved key). */
function CredentialRow({ credential, onSaved, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(credential.label);
  const [model, setModel] = useState(credential.model);
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(null);

  const loadModels = async () => {
    setBusy("models");
    try {
      const result = await listProviderModels(credential.provider, { credentialId: credential.id });
      setModels(result.models);
    } catch (error) {
      toastError(error, "Could not load models with this key");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      await updateLlmCredential(credential.provider, credential.id, { label: label.trim() || undefined, model: model || undefined });
      toastSuccess("Key updated");
      setEditing(false);
      onSaved?.();
    } catch (error) {
      toastError(error, "Could not update the key");
    } finally {
      setBusy(null);
    }
  };

  const options = [...new Set([model, credential.model, ...models].filter(Boolean))];

  return (
    <li className={`border-2 border-black p-3 ${credential.broken ? "bg-orange-50" : "bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-black uppercase">{credential.label}</span>
            <span className="badge-stark text-[9px]">{credential.providerLabel}</span>
            {credential.broken && <span className="badge-stark bg-orange-100 text-[9px]">NEEDS ATTENTION</span>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-gray-600">
            {credential.maskedApiKey} · {credential.model}
          </p>
          {credential.updatedAt && <p className="text-[10px] font-semibold text-gray-500">Updated {formatDate(credential.updatedAt)}</p>}
        </div>
        {!editing && (
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setEditing(true)} className="btn-secondary min-h-9 px-2 py-1 text-[10px]">
              <PencilLine className="h-3.5 w-3.5" aria-hidden="true" /> EDIT
            </button>
            <button type="button" onClick={() => onDelete(credential)} className="btn-secondary min-h-9 px-2 py-1 text-[10px] hover:bg-red-100">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> REMOVE
            </button>
          </div>
        )}
      </div>
      {editing && (
        <div className="mt-2 grid grid-cols-1 gap-2 border-t-[1.5px] border-black pt-2 sm:grid-cols-2">
          <Field label="Name">
            <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} className="input-stark w-full text-base sm:text-xs" />
          </Field>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs font-extrabold uppercase">
              Model
              <button type="button" onClick={loadModels} disabled={Boolean(busy)} className="inline-flex items-center gap-1 text-[9px] font-black underline disabled:opacity-40">
                {busy === "models" ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
                LOAD MODELS
              </button>
            </span>
            <select value={model} onChange={(event) => setModel(event.target.value)} className="input-stark w-full font-mono text-base sm:text-xs">
              {options.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button type="button" onClick={save} disabled={Boolean(busy)} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50">
              {busy === "save" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              SAVE
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setLabel(credential.label);
                setModel(credential.model);
              }}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * `settings.ai-keys` panel (BYOK): saved keys per provider (masked), add a key
 * (model list loaded with the pasted key), rename / change model, remove with
 * confirmation. The key lives only in this form's local state and is cleared
 * after saving — never in Redux, storage or chat.
 */
export default function AiKeysPanel() {
  const { params } = usePanel("settings.ai-keys");
  const keys = useLlmCredentials();
  const [provider, setProvider] = useState(params.provider || "openai");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState({ provider: null, list: [] });
  const [busy, setBusy] = useState(null);
  const [formError, setFormError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  const providerInfo = keys.providers.find((item) => item.id === provider) ?? null;
  const loadedModels = models.provider === provider ? models.list : [];
  const modelOptions = [...new Set([model, providerInfo?.defaultModel, ...loadedModels].filter(Boolean))];
  const effectiveModel = model || providerInfo?.defaultModel || "";

  const chooseProvider = (next) => {
    setProvider(next);
    setModel("");
    setFormError("");
  };

  const loadModels = async () => {
    if (!apiKey.trim()) return setFormError("Paste your API key first to load the models it can use.");
    setBusy("models");
    setFormError("");
    try {
      const result = await listProviderModels(provider, { apiKey: apiKey.trim() });
      setModels({ provider, list: result.models });
      if (result.models.length && !result.models.includes(effectiveModel)) setModel(result.models[0]);
    } catch (error) {
      setFormError(error?.message || "Could not load models with this key");
    } finally {
      setBusy(null);
    }
    return undefined;
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!apiKey.trim()) return setFormError("Paste an API key.");
    setBusy("save");
    setFormError("");
    try {
      await saveLlmCredential(provider, { apiKey: apiKey.trim(), model: effectiveModel || undefined, label: label.trim() || undefined });
      setApiKey("");
      setLabel("");
      setModels({ provider: null, list: [] });
      toastSuccess("API key saved securely");
      keys.reload();
    } catch (error) {
      setFormError(error?.message || "Could not save the key");
    } finally {
      setBusy(null);
    }
    return undefined;
  };

  const remove = async () => {
    const credential = confirmDelete;
    if (!credential) return;
    setBusy("delete");
    try {
      await deleteLlmCredential(credential.provider, credential.id);
      toastSuccess("API key removed");
      keys.reload();
    } catch (error) {
      toastError(error, "Could not remove the key");
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  if (keys.disabled) {
    return (
      <Panel title="AI keys (BYOK)" icon={KeyRound}>
        <EmptyState icon={KeyRound} title="AI keys are unavailable" text="Bring-your-own-key AI is not configured on this server. Ask your administrator to enable it." />
      </Panel>
    );
  }

  return (
    <Panel title="AI keys (BYOK)" icon={KeyRound} badge="ENCRYPTED">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form onSubmit={submit} className="space-y-3" autoComplete="off">
          <h4 className="text-xs font-black uppercase">Add a key</h4>
          <Field label="Provider">
            <select value={provider} onChange={(event) => chooseProvider(event.target.value)} className="input-stark w-full text-base sm:text-xs">
              {(keys.providers.length ? keys.providers : [{ id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic" }, { id: "google", label: "Google" }, { id: "xai", label: "xAI" }]).map(
                (item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="API key" hint="Add as many keys as you need; existing keys are not replaced.">
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your API key"
              className="input-stark w-full font-mono text-base sm:text-xs"
            />
          </Field>
          <Field label="Key name">
            <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} placeholder="Personal, project…" className="input-stark w-full text-base sm:text-xs" />
          </Field>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs font-extrabold uppercase">
              Model
              <button type="button" onClick={loadModels} disabled={Boolean(busy)} className="inline-flex items-center gap-1 text-[9px] font-black underline disabled:opacity-40">
                {busy === "models" ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
                LOAD AVAILABLE MODELS
              </button>
            </span>
            <select value={effectiveModel} onChange={(event) => setModel(event.target.value)} className="input-stark w-full font-mono text-base sm:text-xs">
              {!modelOptions.length && <option value="">Default model</option>}
              {modelOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                  {item === providerInfo?.defaultModel ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          {formError && (
            <p role="alert" className="border-2 border-black bg-red-50 p-2 text-[11px] font-bold text-red-800">
              {formError}
            </p>
          )}
          <button type="submit" disabled={Boolean(busy)} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {busy === "save" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            SAVE API KEY
          </button>
          <p className="flex items-start gap-1.5 text-[10px] font-semibold text-gray-600">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Keys are encrypted on the server and only masked values are shown. Never paste API keys into the chat.
          </p>
        </form>

        <section className="min-w-0">
          <h4 className="mb-2 text-xs font-black uppercase">Saved keys ({keys.credentials.length})</h4>
          {keys.error ? (
            <ErrorState error={keys.error} title="COULD NOT LOAD YOUR KEYS" onRetry={keys.reload} />
          ) : keys.loading && !keys.providers.length ? (
            <LoadingState label="LOADING KEYS…" />
          ) : keys.credentials.length === 0 ? (
            <EmptyState icon={KeyRound} title="No keys saved yet" text="Add an OpenAI, Anthropic, Google or xAI key to use AI resume tailoring." />
          ) : (
            <ul className="space-y-2">
              {keys.credentials.map((credential) => (
                <CredentialRow key={`${credential.id}:${credential.label}:${credential.model}`} credential={credential} onSaved={keys.reload} onDelete={setConfirmDelete} />
              ))}
            </ul>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Remove API key?"
        danger
        busy={busy === "delete"}
        confirmLabel="REMOVE"
        body={`“${confirmDelete?.label}” (${confirmDelete?.providerLabel} · ${confirmDelete?.maskedApiKey}) will be deleted. Tailoring with it will stop working.`}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(null)}
      />
    </Panel>
  );
}

export { AiKeysPanel as AiKeysSettings };
