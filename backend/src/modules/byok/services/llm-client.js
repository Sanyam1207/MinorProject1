// Provider-neutral LLM client over raw `fetch` (RESUME-BYOK.md §9.3), ported
// from Matchy's GenericLlmClient. No provider SDKs.
//
//   new GenericLlmClient(provider, apiKey, model).complete(messages, {jsonMode})
//     → {provider, model, content, stopReason, usage: {inputTokens, outputTokens} | null}
//   listProviderModels(provider, apiKey) → string[]
//
// Every failure is an ApiError (so it carries `statusCode`); the API key is
// never logged, returned or embedded in an error message.
import { fail } from "../../../core/http.js";
import { anthropicMaxTokens, modelsTimeoutMs, requestTimeoutMs } from "../config.js";
import { LLM_SYSTEM_PROMPT, getLlmProvider, normalizeLlmModel } from "../providers.js";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const MAX_MODEL_PAGES = 5;
const NON_CHAT_MODEL = /embedding|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image/i;
const GOOGLE_BLOCK_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

const REFUSED_MESSAGE = "The AI model declined this request (safety filter). Try a different job description or another model.";
const TRUNCATED_MESSAGE = "The AI's answer was cut off before it finished. Try again, choose a larger model, or shorten the job description.";

const redact = (text, apiKey) => {
    let output = String(text ?? "");
    if (apiKey && apiKey.length >= 4) output = output.split(apiKey).join("[redacted]");
    return output.replace(/\b(sk|xai|AIza)[-_A-Za-z0-9]{12,}\b/g, "[redacted]").slice(0, 500);
};

const logCall = (fields) => {
    if (process.env.NODE_ENV === "test") return;
    console.log(`[byok] llm ${JSON.stringify(fields)}`);
};

const validateMessages = (messages) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw fail(400, "At least one LLM message is required.", "VALIDATION", { field: "messages" });
    }
    return messages.map((message, index) => {
        if (!["user", "assistant", "system"].includes(message?.role) || typeof message.content !== "string") {
            throw fail(400, "Each LLM message requires a valid role (user, assistant or system) and string content.", "VALIDATION", { field: `messages[${index}]` });
        }
        return { role: message.role, content: message.content };
    });
};

const providerMessage = (body) => {
    if (!body || typeof body !== "object") return "";
    if (typeof body.error === "string") return body.error;
    return body.error?.message || body.error?.[0]?.message || body[0]?.error?.message || body.message || "";
};

/** Map a provider HTTP error to the envelope codes (§9.3). */
export const providerHttpError = (provider, status, body, apiKey) => {
    const detail = redact(providerMessage(body), apiKey);
    const suffix = detail ? ` (${detail})` : "";
    if (status === 401 || status === 403) {
        return fail(422, `${provider.label} rejected the API key${suffix}. Update it in Resume Lab → AI keys.`, "LLM_KEY_INVALID", { provider: provider.id, providerStatus: status });
    }
    if (status === 404) {
        return fail(422, `${provider.label} doesn't offer this model${suffix}. Choose another model for the key.`, "LLM_MODEL_NOT_FOUND", { provider: provider.id, providerStatus: status });
    }
    if (status === 429) {
        return fail(429, "Your provider account is rate-limited or out of credit.", "LLM_RATE_LIMITED", { provider: provider.id, providerStatus: status });
    }
    if (status >= 500 || status === 529) {
        return fail(502, `${provider.label} had a problem answering${suffix}. Try again in a moment.`, "LLM_PROVIDER_ERROR", { provider: provider.id, providerStatus: status });
    }
    return fail(422, `${provider.label} rejected the request${suffix}.`, "LLM_BAD_REQUEST", { provider: provider.id, providerStatus: status });
};

const isTimeout = (error) => error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === 23;

/** fetch + JSON with timeout and network/timeout mapping. */
const fetchJson = async (provider, url, options, timeoutMs, apiKey) => {
    const fetchImpl = globalThis.fetch;
    let response;
    try {
        response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        if (isTimeout(error)) throw fail(504, `${provider.label} took too long to answer. Try again or pick a faster model.`, "LLM_TIMEOUT", { provider: provider.id });
        throw fail(502, `Could not reach ${provider.label}. Check the server's internet connection and try again.`, "LLM_PROVIDER_ERROR", { provider: provider.id });
    }
    let body = {};
    try {
        const text = await response.text();
        body = text ? JSON.parse(text) : {};
    } catch (error) {
        if (isTimeout(error)) throw fail(504, `${provider.label} took too long to answer. Try again or pick a faster model.`, "LLM_TIMEOUT", { provider: provider.id });
        if (response.ok) throw fail(502, `${provider.label} returned an unreadable response.`, "LLM_PROVIDER_ERROR", { provider: provider.id });
        body = {};
    }
    if (!response.ok) throw providerHttpError(provider, response.status, body, apiKey);
    return { status: response.status, body };
};

const refused = (provider, category = null) => fail(422, REFUSED_MESSAGE, "LLM_REFUSED", { provider: provider.id, category });
const truncated = (provider) => fail(502, TRUNCATED_MESSAGE, "LLM_TRUNCATED", { provider: provider.id });
const malformed = (provider, why) => fail(502, `${provider.label} returned an unexpected answer (${why}). Try again.`, "LLM_PROVIDER_ERROR", { provider: provider.id });

export class GenericLlmClient {
    constructor(provider, apiKey, model) {
        this.provider = getLlmProvider(provider);
        this.model = normalizeLlmModel(this.provider.id, typeof model === "string" && model.trim() ? model.trim() : this.provider.defaultModel);
        // Non-enumerable so the key never shows up in logs or JSON of the client.
        Object.defineProperty(this, "apiKey", { value: String(apiKey ?? ""), enumerable: false, writable: false });
    }

    /** Provider request for normalized messages (exact wire formats of §9.3). */
    buildRequest(messages, { jsonMode = false } = {}) {
        const { id, endpoint } = this.provider;
        if (id === "anthropic") {
            const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
            // Exactly {model, max_tokens, system, messages}: no temperature/top_p/top_k
            // (rejected by current models), no thinking/output_config, no beta header.
            return {
                url: endpoint,
                options: {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-api-key": this.apiKey,
                        "anthropic-version": ANTHROPIC_VERSION,
                    },
                    body: JSON.stringify({
                        model: this.model,
                        max_tokens: anthropicMaxTokens(),
                        system,
                        messages: messages.filter((message) => message.role !== "system"),
                    }),
                },
            };
        }
        if (id === "google") {
            const contents = messages.filter((message) => message.role !== "system").map((message) => ({
                role: message.role === "assistant" ? "model" : "user",
                parts: [{ text: message.content }],
            }));
            const system = messages.filter((message) => message.role === "system").map((message) => ({ text: message.content }));
            return {
                url: `${endpoint}/${encodeURIComponent(this.model)}:generateContent`,
                options: {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
                    body: JSON.stringify({
                        ...(system.length ? { systemInstruction: { parts: system } } : {}),
                        contents,
                        ...(jsonMode ? { generationConfig: { responseMimeType: "application/json" } } : {}),
                    }),
                },
            };
        }
        return {
            url: endpoint,
            options: {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
                }),
            },
        };
    }

    /** Check stop/finish reasons BEFORE reading content, then extract the text. */
    parseResponse(body) {
        const provider = this.provider;
        if (provider.id === "anthropic") {
            const stopReason = body?.stop_reason ?? null;
            if (stopReason === "refusal") throw refused(provider, body?.stop_details?.category ?? null);
            if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") throw truncated(provider);
            if (stopReason === "pause_turn" || stopReason === "tool_use") throw malformed(provider, `stop reason ${stopReason}`);
            if (!Array.isArray(body?.content)) throw malformed(provider, "no content");
            const content = body.content
                .filter((block) => block?.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join("");
            const usage = body.usage
                ? { inputTokens: body.usage.input_tokens ?? null, outputTokens: body.usage.output_tokens ?? null }
                : null;
            return { content, stopReason, usage };
        }
        if (provider.id === "google") {
            if (body?.promptFeedback?.blockReason) throw refused(provider, String(body.promptFeedback.blockReason).toLowerCase());
            const candidate = body?.candidates?.[0];
            if (!candidate) throw malformed(provider, "no candidates");
            const stopReason = candidate.finishReason ?? null;
            if (GOOGLE_BLOCK_REASONS.has(stopReason)) throw refused(provider, String(stopReason).toLowerCase());
            if (stopReason === "MAX_TOKENS") throw truncated(provider);
            const content = (candidate.content?.parts || [])
                .filter((part) => part && part.thought !== true && typeof part.text === "string")
                .map((part) => part.text)
                .join("");
            const meta = body.usageMetadata;
            const usage = meta ? { inputTokens: meta.promptTokenCount ?? null, outputTokens: meta.candidatesTokenCount ?? null } : null;
            return { content, stopReason, usage };
        }
        const choice = body?.choices?.[0];
        if (!choice) throw malformed(provider, "no choices");
        const stopReason = choice.finish_reason ?? null;
        if (stopReason === "length") throw truncated(provider);
        if (stopReason === "content_filter") throw refused(provider, "content_filter");
        if (typeof choice.message?.refusal === "string" && choice.message.refusal.trim()) throw refused(provider, null);
        const content = typeof choice.message?.content === "string" ? choice.message.content : "";
        const usage = body.usage
            ? { inputTokens: body.usage.prompt_tokens ?? null, outputTokens: body.usage.completion_tokens ?? null }
            : null;
        return { content, stopReason, usage };
    }

    async complete(messages, { jsonMode = false } = {}) {
        const normalized = validateMessages(messages);
        const withSystem = normalized.some((message) => message.role === "system")
            ? normalized
            : [{ role: "system", content: LLM_SYSTEM_PROMPT }, ...normalized];
        const request = this.buildRequest(withSystem, { jsonMode });
        const started = Date.now();
        let status = null;
        try {
            const response = await fetchJson(this.provider, request.url, request.options, requestTimeoutMs(), this.apiKey);
            status = response.status;
            const parsed = this.parseResponse(response.body);
            return { provider: this.provider.id, model: this.model, ...parsed };
        } catch (error) {
            status = error?.errors?.[0]?.providerStatus ?? error?.errors?.[0]?.code ?? "error";
            throw error;
        } finally {
            logCall({ provider: this.provider.id, model: this.model, status, ms: Date.now() - started });
        }
    }
}

/** Model ids available to `apiKey` (paginated, filtered; §9.3). */
export const listProviderModels = async (providerId, apiKey) => {
    const provider = getLlmProvider(providerId);
    const key = String(apiKey ?? "");
    const timeout = modelsTimeoutMs();
    const ids = [];

    if (provider.id === "anthropic") {
        let afterId = null;
        for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
            const url = new URL(ANTHROPIC_MODELS_URL);
            url.searchParams.set("limit", "100");
            if (afterId) url.searchParams.set("after_id", afterId);
            const { body } = await fetchJson(provider, url.toString(), {
                method: "GET",
                headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
            }, timeout, key);
            const data = Array.isArray(body?.data) ? body.data : [];
            ids.push(...data.map((model) => model?.id).filter(Boolean));
            afterId = body?.last_id || data[data.length - 1]?.id || null;
            if (!body?.has_more || !afterId) break;
        }
    } else if (provider.id === "google") {
        let pageToken = null;
        for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
            const url = new URL(provider.endpoint);
            url.searchParams.set("pageSize", "1000");
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const { body } = await fetchJson(provider, url.toString(), {
                method: "GET",
                headers: { "x-goog-api-key": key },
            }, timeout, key);
            const models = Array.isArray(body?.models) ? body.models : [];
            ids.push(...models
                .filter((model) => Array.isArray(model?.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
                .map((model) => String(model.name || "").replace(/^models\//, ""))
                .filter(Boolean));
            pageToken = body?.nextPageToken || null;
            if (!pageToken) break;
        }
    } else {
        const url = provider.endpoint.replace(/\/chat\/completions$/, "/models");
        const { body } = await fetchJson(provider, url, {
            method: "GET",
            headers: { authorization: `Bearer ${key}` },
        }, timeout, key);
        ids.push(...(Array.isArray(body?.data) ? body.data : [])
            .map((model) => model?.id)
            .filter((id) => typeof id === "string" && id && !NON_CHAT_MODEL.test(id)));
    }
    return [...new Set(ids)];
};
