// Module "byok" (docs/contracts/RESUME-BYOK.md §9, §14): bring-your-own-key LLM
// credentials, the provider-neutral client and surgical resume tailoring.
//
// Named exports are a stable interface for other modules (JOB-FEED §11.3 uses
// decryptApiKey + GenericLlmClient for WhatsApp extraction with a TPO's key):
//   new GenericLlmClient(provider, apiKey, model).complete(messages, {jsonMode}) → {content, …}
//   Its errors are ApiErrors, so they carry `statusCode` (and errors[0].code).
import router from "./routes.js";
import { isByokEnabled } from "./services/credentials.service.js";
import tools from "./tools.js";

const start = async () => {
    if (!isByokEnabled()) {
        console.warn("[byok] LLM_CREDENTIAL_ENCRYPTION_KEY is missing or not a base64 32-byte key; AI keys (BYOK) are disabled.");
    }
};

export default { name: "byok", mountPath: "/api/v1/llm", router, start, tools };

export { decryptApiKey, encryptApiKey, isByokEnabled, maskApiKey } from "./services/credentials.service.js";
export { GenericLlmClient, listProviderModels } from "./services/llm-client.js";
export { LLM_PROVIDERS, LLM_SYSTEM_PROMPT, getLlmProvider, normalizeLlmModel } from "./providers.js";
