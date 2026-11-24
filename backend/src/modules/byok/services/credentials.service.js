// Bring-your-own-key credentials (RESUME-BYOK.md §2.3, §9.2), ported from
// Matchy `llm-credentials.service.js`.
//
// - AES-256-GCM, stored as `ivB64.tagB64.cipherB64` (12-byte IV), Matchy's format.
// - User.llmCredentials is select:false: every read re-queries "+llmCredentials".
// - Writes are atomic updateOne calls ($push / $pull / positional $set); never user.save().
// - A decrypted key is never logged, returned, or embedded in errors, notifications or URLs.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { fail, isObjectId } from "../../../core/http.js";
import { User } from "../../../models/user.models.js";
import { encryptionKeyValue, maxCredentials } from "../config.js";
import { LLM_PROVIDERS, PROVIDER_IDS, getLlmProvider, normalizeLlmModel } from "../providers.js";

const byokDisabled = () => fail(503, "AI keys are not configured on this server", "BYOK_DISABLED");

const encryptionKey = () => {
    const value = encryptionKeyValue();
    if (!value) return null;
    const key = Buffer.from(value, "base64");
    return key.length === 32 ? key : null;
};

/** True when LLM_CREDENTIAL_ENCRYPTION_KEY is a base64 32-byte key (checked at call time). */
export const isByokEnabled = () => Boolean(encryptionKey());

export const assertByokEnabled = () => {
    if (!isByokEnabled()) throw byokDisabled();
};

export const encryptApiKey = (apiKey) => {
    const key = encryptionKey();
    if (!key) throw byokDisabled();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(String(apiKey), "utf8"), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
};

/** Decrypt a stored key. Throws 503 BYOK_DISABLED or 422 LLM_KEY_INVALID (unreadable). */
export const decryptApiKey = (value) => {
    const key = encryptionKey();
    if (!key) throw byokDisabled();
    try {
        const [ivValue, tagValue, encryptedValue] = String(value ?? "").split(".");
        if (!ivValue || !tagValue || encryptedValue === undefined) throw new Error("malformed");
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64")), decipher.final()]).toString("utf8");
    } catch {
        throw fail(422, "The saved API key can no longer be read (the server's encryption key changed). Save the key again.", "LLM_KEY_INVALID");
    }
};

export const maskApiKey = (apiKey) => {
    const text = String(apiKey ?? "");
    return text.length <= 8 ? "••••••••" : `${text.slice(0, 4)}••••${text.slice(-4)}`;
};

const tryDecrypt = (value) => {
    try {
        return decryptApiKey(value);
    } catch {
        return null;
    }
};

// ── validation ─────────────────────────────────────────────────────────────

export const cleanApiKey = (value) => {
    const apiKey = typeof value === "string" ? value.trim() : "";
    if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) {
        throw fail(400, "Enter a valid API key (8–512 characters, no spaces).", "VALIDATION", { field: "apiKey" });
    }
    return apiKey;
};

const cleanModel = (value, provider) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.trim().length > 200) throw fail(400, "model must be a model id (≤ 200 characters)", "VALIDATION", { field: "model" });
    return normalizeLlmModel(provider, value.trim()) || null;
};

const cleanLabel = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim().length > 80) throw fail(400, "label must contain at most 80 characters", "VALIDATION", { field: "label" });
    return value.trim() || null;
};

const assertCredentialId = (value) => {
    if (!isObjectId(String(value ?? ""))) throw fail(400, "credentialId must be a valid id", "VALIDATION", { field: "credentialId" });
    return String(value);
};

const credentialNotFound = () => fail(404, "Saved API key not found", "NOT_FOUND", { entity: "credential" });

// ── reads ──────────────────────────────────────────────────────────────────

const loadCredentials = async (userId) => {
    const user = await User.findById(userId).select("+llmCredentials").lean();
    return Array.isArray(user?.llmCredentials) ? user.llmCredentials : [];
};

const newestFirst = (left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);

const backfillKeyHint = async (userId, credentialId, hint) => {
    try {
        await User.updateOne(
            { _id: userId, "llmCredentials._id": credentialId },
            { $set: { "llmCredentials.$.keyHint": hint } },
            { timestamps: false },
        );
    } catch (error) {
        console.warn(`[byok] keyHint backfill failed: ${error?.message || error}`);
    }
};

/** Public view of one saved credential (no key material beyond the hint). */
const describeCredential = async (userId, credential) => {
    const provider = credential.provider;
    const decrypted = tryDecrypt(credential.encryptedApiKey);
    const broken = decrypted === null;
    let hint = credential.keyHint || null;
    if (!broken && !hint) {
        hint = maskApiKey(decrypted);
        await backfillKeyHint(userId, credential._id, hint);
    }
    return {
        id: String(credential._id),
        label: credential.label || `${LLM_PROVIDERS[provider]?.label || provider} key`,
        model: normalizeLlmModel(provider, credential.model || LLM_PROVIDERS[provider]?.defaultModel),
        maskedApiKey: broken ? null : hint,
        updatedAt: credential.updatedAt || null,
        broken,
    };
};

/** GET /llm/providers → Provider[] in table order. A decrypt failure never gives 500. */
export const listProviders = async (userId) => {
    const credentials = await loadCredentials(userId);
    const output = [];
    for (const id of PROVIDER_IDS) {
        const config = LLM_PROVIDERS[id];
        const own = credentials.filter((credential) => credential.provider === id).sort(newestFirst);
        const described = [];
        for (const credential of own) described.push(await describeCredential(userId, credential));
        const first = described[0];
        output.push({
            id,
            label: config.label,
            defaultModel: config.defaultModel,
            configured: described.length > 0,
            model: first ? first.model : config.defaultModel,
            maskedApiKey: first ? first.maskedApiKey : null,
            credentials: described,
        });
    }
    return output;
};

// ── writes ─────────────────────────────────────────────────────────────────

/** PUT /llm/credentials/:provider — APPENDS a credential (409 TOO_MANY_KEYS past the cap). */
export const saveCredential = async (userId, providerParam, body = {}) => {
    assertByokEnabled();
    const provider = getLlmProvider(providerParam);
    const apiKey = cleanApiKey(body.apiKey);
    const model = cleanModel(body.model, provider.id) || provider.defaultModel;
    const label = cleanLabel(body.label) || `${provider.label} key`;
    const entry = {
        _id: new mongoose.Types.ObjectId(),
        label,
        provider: provider.id,
        encryptedApiKey: encryptApiKey(apiKey),
        model,
        keyHint: maskApiKey(apiKey),
        updatedAt: new Date(),
    };
    const limit = maxCredentials();
    const result = await User.updateOne(
        { _id: userId, $expr: { $lt: [{ $size: { $ifNull: ["$llmCredentials", []] } }, limit] } },
        { $push: { llmCredentials: entry } },
        { runValidators: true },
    );
    if (!result.matchedCount) {
        throw fail(409, `You can save at most ${limit} API keys. Remove one first.`, "TOO_MANY_KEYS", { limit });
    }
    return { credentialId: String(entry._id), label, provider: provider.id, model, maskedApiKey: entry.keyHint };
};

/** PATCH /llm/credentials/:provider/:credentialId — label, model and/or apiKey. */
export const updateCredential = async (userId, providerParam, credentialIdParam, body = {}) => {
    assertByokEnabled();
    const provider = getLlmProvider(providerParam);
    const credentialId = assertCredentialId(credentialIdParam);
    const set = {};
    if (body.label !== undefined) set["llmCredentials.$.label"] = cleanLabel(body.label) || `${provider.label} key`;
    if (body.model !== undefined) set["llmCredentials.$.model"] = cleanModel(body.model, provider.id) || provider.defaultModel;
    if (body.apiKey !== undefined) {
        const apiKey = cleanApiKey(body.apiKey);
        set["llmCredentials.$.encryptedApiKey"] = encryptApiKey(apiKey);
        set["llmCredentials.$.keyHint"] = maskApiKey(apiKey);
    }
    if (!Object.keys(set).length) throw fail(400, "Send at least one of label, model or apiKey", "VALIDATION");
    set["llmCredentials.$.updatedAt"] = new Date();
    const result = await User.updateOne(
        { _id: userId, llmCredentials: { $elemMatch: { _id: credentialId, provider: provider.id } } },
        { $set: set },
        { runValidators: true },
    );
    if (!result.matchedCount) throw credentialNotFound();
    const credential = (await loadCredentials(userId)).find((item) => String(item._id) === credentialId);
    if (!credential) throw credentialNotFound();
    const described = await describeCredential(userId, credential);
    return { credentialId, label: described.label, provider: provider.id, model: described.model, maskedApiKey: described.maskedApiKey };
};

/** DELETE /llm/credentials/:provider/:credentialId → {deleted: 0|1}. */
export const deleteCredential = async (userId, providerParam, credentialIdParam) => {
    assertByokEnabled();
    const provider = getLlmProvider(providerParam);
    const credentialId = assertCredentialId(credentialIdParam);
    const result = await User.updateOne(
        { _id: userId },
        { $pull: { llmCredentials: { _id: new mongoose.Types.ObjectId(credentialId), provider: provider.id } } },
    );
    return { deleted: result.modifiedCount ? 1 : 0 };
};

/** DELETE /llm/credentials/:provider → {deleted: n} (all keys of the provider). */
export const deleteProviderCredentials = async (userId, providerParam) => {
    assertByokEnabled();
    const provider = getLlmProvider(providerParam);
    const count = (await loadCredentials(userId)).filter((credential) => credential.provider === provider.id).length;
    if (!count) return { deleted: 0 };
    await User.updateOne({ _id: userId }, { $pull: { llmCredentials: { provider: provider.id } } });
    return { deleted: count };
};

// ── selection ──────────────────────────────────────────────────────────────

/** Notify the owner that a saved key stopped working (lazy notifications import; no-op if missing). */
export const notifyKeyInvalid = async (userId, credential) => {
    if (!credential?._id) return;
    try {
        const { notify } = await import("../../notifications/notify.js");
        const providerLabel = LLM_PROVIDERS[credential.provider]?.label || credential.provider;
        const label = credential.label || `${providerLabel} key`;
        const updatedMs = new Date(credential.updatedAt || 0).getTime() || 0;
        await notify([userId], {
            type: "llm.key_invalid",
            title: `Your ${providerLabel} key “${label}” stopped working`,
            body: `${providerLabel} rejected the key or it can no longer be read. Update or remove it in Resume Lab → AI keys.`,
            ui: { panel: "settings.ai-keys", params: { provider: credential.provider } },
            priority: "normal",
            data: { provider: credential.provider, credentialId: String(credential._id) },
            dedupeKey: `llm-key-invalid:${credential._id}:${updatedMs}`,
            email: false,
        });
    } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND") console.warn(`[byok] key-invalid notification failed: ${error?.message || error}`);
    }
};

/**
 * Choose a saved credential: explicit id (must match provider when both given)
 * → provider's newest → newest overall. Decrypts it.
 * @returns {Promise<{credential, apiKey, provider, model}>}
 */
export const pickCredential = async (userId, { credentialId, provider: providerParam, model } = {}) => {
    assertByokEnabled();
    const provider = providerParam ? getLlmProvider(providerParam).id : null;
    const credentials = (await loadCredentials(userId)).sort(newestFirst);
    let credential;
    if (credentialId !== undefined && credentialId !== null && credentialId !== "") {
        const id = assertCredentialId(credentialId);
        credential = credentials.find((item) => String(item._id) === id && (!provider || item.provider === provider));
        if (!credential) throw credentialNotFound();
    } else {
        credential = provider ? credentials.find((item) => item.provider === provider) : credentials[0];
    }
    if (!credential) {
        throw fail(422, "Add an API key for resume tailoring first (Resume Lab → AI keys).", "LLM_KEY_REQUIRED");
    }
    let apiKey;
    try {
        apiKey = decryptApiKey(credential.encryptedApiKey);
    } catch (error) {
        if (error?.errors?.[0]?.code === "LLM_KEY_INVALID") await notifyKeyInvalid(userId, credential);
        throw error;
    }
    const requested = typeof model === "string" && model.trim() ? model.trim() : null;
    const chosenModel = normalizeLlmModel(credential.provider, requested || credential.model || LLM_PROVIDERS[credential.provider].defaultModel);
    return { credential, apiKey, provider: credential.provider, model: chosenModel };
};

/**
 * Resolve a tool's `credentialId` argument: a saved key id, a provider name or a key label.
 * @returns {Promise<{credentialId?: string, provider?: string} | {ambiguous: true, message, candidates}>}
 */
export const resolveCredentialRef = async (userId, ref) => {
    const text = typeof ref === "string" ? ref.trim() : "";
    if (!text) return {};
    if (isObjectId(text)) return { credentialId: text };
    if (PROVIDER_IDS.includes(text.toLowerCase())) return { provider: text.toLowerCase() };
    const credentials = await loadCredentials(userId);
    const lower = text.toLowerCase();
    const exact = credentials.filter((item) => String(item.label || "").toLowerCase() === lower);
    const matches = exact.length ? exact : credentials.filter((item) => String(item.label || "").toLowerCase().includes(lower));
    if (matches.length === 1) return { credentialId: String(matches[0]._id) };
    if (matches.length > 1) {
        return {
            ambiguous: true,
            message: "Which saved key should I use?",
            candidates: matches.slice(0, 8).map((item) => ({
                id: String(item._id),
                label: `${item.label || "key"} · ${LLM_PROVIDERS[item.provider]?.label || item.provider}${item.keyHint ? ` · ${item.keyHint}` : ""}`,
            })),
        };
    }
    throw fail(404, `No saved key matches '${text}'`, "NOT_FOUND", { entity: "credential" });
};

/** Whether the user has at least one saved credential. */
export const hasCredentials = async (userId) => (await loadCredentials(userId)).length > 0;
