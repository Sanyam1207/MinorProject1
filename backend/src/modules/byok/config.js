// BYOK configuration (docs/contracts/RESUME-BYOK.md §15). Read at call time.
const intEnv = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = String(process.env[name] ?? "").trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
};

export const encryptionKeyValue = () => String(process.env.LLM_CREDENTIAL_ENCRYPTION_KEY ?? "").trim();
export const requestTimeoutMs = () => intEnv("LLM_REQUEST_TIMEOUT_MS", 90_000, { min: 100 });
export const modelsTimeoutMs = () => intEnv("LLM_MODELS_TIMEOUT_MS", 15_000, { min: 100 });
export const anthropicMaxTokens = () => intEnv("LLM_ANTHROPIC_MAX_TOKENS", 16_000, { min: 256, max: 128_000 });
export const maxCredentials = () => intEnv("LLM_MAX_CREDENTIALS", 10, { min: 1, max: 100 });
export const tailorRateLimitPerHour = () => intEnv("TAILOR_RATE_LIMIT_PER_HOUR", 30, { min: 1, max: 10_000 });

export const CHAT_MAX_MESSAGES = 40;
export const CHAT_MAX_CHARS = 100_000;
