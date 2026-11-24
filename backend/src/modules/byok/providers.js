// LLM providers for bring-your-own-key tailoring (RESUME-BYOK.md §9.1),
// ported from Matchy `config/llm.js` + `config/constants.js`.
import { fail } from "../../core/http.js";

export const LLM_PROVIDERS = Object.freeze({
    openai: Object.freeze({
        label: "OpenAI",
        defaultModel: "gpt-4o-mini",
        endpoint: "https://api.openai.com/v1/chat/completions",
    }),
    anthropic: Object.freeze({
        label: "Anthropic",
        // Claude Haiku 3.5 was retired on 2026-02-19; Claude Haiku 5.5 is the current Haiku.
        defaultModel: "claude-haiku-5-5",
        endpoint: "https://api.anthropic.com/v1/messages",
    }),
    google: Object.freeze({
        label: "Google",
        defaultModel: "gemini-3.1-pro-preview",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    }),
    xai: Object.freeze({
        label: "xAI",
        defaultModel: "grok-3-mini",
        endpoint: "https://api.x.ai/v1/chat/completions",
    }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(LLM_PROVIDERS));

export const LLM_SYSTEM_PROMPT =
    "You are a helpful assistant. Follow the user's instructions and provide clear, accurate responses.";

// Saved models that no longer exist (retired), mapped to their replacement.
const MODEL_REPLACEMENTS = Object.freeze({
    anthropic: Object.freeze({
        "claude-3-5-haiku-latest": "claude-haiku-5-5",
        "claude-3-5-haiku-20241022": "claude-haiku-5-5",
        "claude-3-haiku-20240307": "claude-haiku-5-5",
    }),
    google: Object.freeze({
        "gemini-2.5-pro": "gemini-3.1-pro-preview",
    }),
});

/** Map retired saved models to their replacement; anything else is returned unchanged. */
export const normalizeLlmModel = (provider, model) => {
    if (typeof model !== "string") return model;
    const trimmed = model.trim();
    return MODEL_REPLACEMENTS[provider]?.[trimmed] ?? trimmed;
};

/** `{id, label, defaultModel, endpoint}`; unknown providers → 400 UNSUPPORTED_PROVIDER. */
export const getLlmProvider = (provider) => {
    const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    const config = LLM_PROVIDERS[normalized];
    if (!config) {
        throw fail(400, `Unsupported LLM provider. Choose one of: ${PROVIDER_IDS.join(", ")}.`, "UNSUPPORTED_PROVIDER");
    }
    return { id: normalized, ...config };
};
