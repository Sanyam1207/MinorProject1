// BYOK LLM API (FRONTEND.md §14.8, verified against RESUME-BYOK.md §9.4 and
// backend/src/modules/byok/routes.js). Keys are sent only from the AI keys
// form, never stored client-side and never echoed back (masked values only).
//
// Errors worth branching on (error.code): BYOK_DISABLED (503), LLM_KEY_REQUIRED,
// LLM_KEY_INVALID, LLM_REFUSED, LLM_TRUNCATED, LLM_BAD_JSON, TOO_MANY_KEYS,
// TOO_MANY_ATTEMPTS, VALIDATION.
import { http } from "../http.js";

const id = (value) => encodeURIComponent(String(value ?? ""));

export const LLM_PROVIDER_IDS = Object.freeze(["openai", "anthropic", "google", "xai"]);
export const JD_MIN_CHARS = 30;
export const JD_MAX_CHARS = 20000;

const TAILOR_TIMEOUT_MS = 120000;

const normalizeCredential = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const credentialId = raw.id ?? raw._id ?? raw.credentialId;
  if (!credentialId) return null;
  return {
    id: String(credentialId),
    label: raw.label || "API key",
    model: raw.model || "",
    maskedApiKey: raw.maskedApiKey || "",
    updatedAt: raw.updatedAt ?? null,
    broken: Boolean(raw.broken),
  };
};

const normalizeProvider = (raw) => {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const credentials = (Array.isArray(raw.credentials) ? raw.credentials : []).map(normalizeCredential).filter(Boolean);
  return {
    id: String(raw.id),
    label: raw.label || String(raw.id),
    defaultModel: raw.defaultModel || "",
    configured: Boolean(raw.configured ?? credentials.length > 0),
    model: raw.model || raw.defaultModel || "",
    maskedApiKey: raw.maskedApiKey ?? null,
    credentials,
  };
};

/** Provider[] `{id, label, defaultModel, configured, model, maskedApiKey, credentials[]}`. */
export async function listLlmProviders() {
  const data = await http.get("/llm/providers");
  return (Array.isArray(data) ? data : []).map(normalizeProvider).filter(Boolean);
}

/** Every saved credential across providers: `{...credential, provider, providerLabel}` (pure). */
export const flattenCredentials = (providers) =>
  (Array.isArray(providers) ? providers : []).flatMap((provider) =>
    (provider.credentials || []).map((credential) => ({ ...credential, provider: provider.id, providerLabel: provider.label })),
  );

/** Models for a provider using a pasted key (`apiKey`) or a saved one (`credentialId`) → `{provider, models, source}`. */
export async function listProviderModels(provider, { apiKey, credentialId } = {}) {
  const body = {};
  if (apiKey) body.apiKey = apiKey;
  else if (credentialId) body.credentialId = credentialId;
  const data = await http.post(`/llm/providers/${id(provider)}/models`, body, { timeout: 30000 });
  return {
    provider: data?.provider ?? provider,
    models: Array.isArray(data?.models) ? data.models.filter((model) => typeof model === "string") : [],
    source: data?.source ?? null,
  };
}

/** Add a key (never replaces existing ones) → `{credentialId, label, provider, model, maskedApiKey}`. */
export async function saveLlmCredential(provider, { apiKey, model, label } = {}) {
  const body = { apiKey };
  if (model) body.model = model;
  if (label) body.label = label;
  return http.put(`/llm/credentials/${id(provider)}`, body);
}

/** Rename / change model / rotate a saved key. */
export async function updateLlmCredential(provider, credentialId, { label, model, apiKey } = {}) {
  const body = {};
  if (label !== undefined) body.label = label;
  if (model !== undefined) body.model = model;
  if (apiKey) body.apiKey = apiKey;
  return http.patch(`/llm/credentials/${id(provider)}/${id(credentialId)}`, body);
}

export async function deleteLlmCredential(provider, credentialId) {
  const data = await http.delete(`/llm/credentials/${id(provider)}/${id(credentialId)}`);
  return { deleted: Number(data?.deleted) || 0 };
}

/**
 * POST /llm/tailor → TailorResult
 *   `{success: true, requiresManualJD: false, resumeId, sourceHash, revision, fileType, appliesTo,
 *     job, jobId, jobSource, jobDescriptionSource, provider, model, credentialId,
 *     missingKeywordsFound, totalPatches, patches, skipped, generatedAt}`
 * or NeedsJd `{success: false, requiresManualJD: true, message, job, jobId, jobSource, resumeId}`.
 */
export async function tailorResume({
  resumeId,
  resumeContent,
  jobId,
  jobSource,
  credentialId,
  provider,
  model,
  manualJobDescription,
  fileType,
} = {}) {
  const body = {};
  if (resumeId) body.resumeId = resumeId;
  else if (resumeContent) {
    body.resumeContent = resumeContent;
    if (fileType) body.fileType = fileType;
  }
  if (jobId) body.jobId = jobId;
  if (jobSource) body.jobSource = jobSource;
  if (credentialId) body.credentialId = credentialId;
  if (provider) body.provider = provider;
  if (model) body.model = model;
  if (typeof manualJobDescription === "string" && manualJobDescription.trim()) body.manualJobDescription = manualJobDescription.trim();
  const data = await http.post("/llm/tailor", body, { timeout: TAILOR_TIMEOUT_MS });
  return {
    ...data,
    requiresManualJD: Boolean(data?.requiresManualJD),
    message: data?.message ?? "",
    patches: Array.isArray(data?.patches) ? data.patches : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
    missingKeywordsFound: Array.isArray(data?.missingKeywordsFound) ? data.missingKeywordsFound : [],
    totalPatches: Number.isFinite(data?.totalPatches) ? data.totalPatches : Array.isArray(data?.patches) ? data.patches.length : 0,
  };
}

/** Saved / job-provided description `{job, text, textSource: "saved"|"job"|null, updatedAt}`. */
export async function getJobDescription(jobSource, jobId) {
  return http.get(`/llm/job-descriptions/${id(jobSource)}/${id(jobId)}`);
}

/** Save a pasted job description for THIS student and THIS job only. */
export async function saveJobDescription(jobSource, jobId, text) {
  return http.put(`/llm/job-descriptions/${id(jobSource)}/${id(jobId)}`, { text });
}

export async function deleteJobDescription(jobSource, jobId) {
  return http.delete(`/llm/job-descriptions/${id(jobSource)}/${id(jobId)}`);
}
