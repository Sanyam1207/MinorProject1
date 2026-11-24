// BYOK REST (/api/v1/llm, RESUME-BYOK.md §9.4).
import { Router } from "express";
import { asyncHandler, assertObjectId, fail, hasRole, requireAuth, requireRole, send } from "../../core/http.js";
import { createLimiter, rateLimit } from "../../core/rate-limit.js";
import { JD_MAX_CHARS, JD_MIN_CHARS } from "../resume-lab/models/job-description-override.model.js";
import {
    deleteSavedJobDescription,
    getSavedJobDescription,
    normalizeJobSource,
    publicJob,
    resolveJob,
    saveJobDescription,
} from "../resume-lab/services/job-ref.service.js";
import { tailorRateLimitPerHour } from "./config.js";
import { getLlmProvider } from "./providers.js";
import {
    cleanApiKey,
    deleteCredential,
    deleteProviderCredentials,
    isByokEnabled,
    listProviders,
    notifyKeyInvalid,
    pickCredential,
    saveCredential,
    updateCredential,
} from "./services/credentials.service.js";
import { listProviderModels } from "./services/llm-client.js";
import { chatCompletion, tailorResume } from "./services/tailor.service.js";

const router = Router();
router.use(requireAuth);

const byokGate = (_req, _res, next) => (isByokEnabled()
    ? next()
    : next(fail(503, "AI keys are not configured on this server", "BYOK_DISABLED")));

// /tailor + /chat share one hourly budget per user; the max is read at call time.
let tailorLimiter = null;
let tailorLimiterMax = null;
const tailorLimit = (req, _res, next) => {
    if (process.env.NODE_ENV === "test" && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== "true") return next();
    const max = tailorRateLimitPerHour();
    if (!tailorLimiter || tailorLimiterMax !== max) {
        tailorLimiter = createLimiter({ windowMs: 3600_000, max });
        tailorLimiterMax = max;
    }
    if (!tailorLimiter.hit(String(req.user._id))) {
        return next(fail(429, "You've reached the hourly tailoring limit. Try again later.", "TOO_MANY_ATTEMPTS"));
    }
    return next();
};

const modelsLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, keyFn: (req) => String(req.user?._id || "") });

// ── providers + credentials ────────────────────────────────────────────────
router.get("/providers", byokGate, asyncHandler(async (req, res) => {
    return send(res, await listProviders(req.user._id), "Providers loaded");
}));

router.post("/providers/:provider/models", byokGate, modelsLimit, asyncHandler(async (req, res) => {
    const provider = getLlmProvider(req.params.provider).id;
    const body = req.body || {};
    if (body.apiKey !== undefined && body.apiKey !== null && body.apiKey !== "") {
        const models = await listProviderModels(provider, cleanApiKey(body.apiKey));
        return send(res, { provider, models, source: "request" }, "Models loaded");
    }
    const picked = await pickCredential(req.user._id, { credentialId: body.credentialId, provider });
    try {
        const models = await listProviderModels(provider, picked.apiKey);
        return send(res, { provider, models, source: "saved" }, "Models loaded");
    } catch (error) {
        if (error?.errors?.[0]?.code === "LLM_KEY_INVALID") await notifyKeyInvalid(req.user._id, picked.credential);
        throw error;
    }
}));

router.put("/credentials/:provider", byokGate, asyncHandler(async (req, res) => {
    const data = await saveCredential(req.user._id, req.params.provider, req.body || {});
    return send(res, data, "API key saved", 201);
}));

router.patch("/credentials/:provider/:credentialId", byokGate, asyncHandler(async (req, res) => {
    const data = await updateCredential(req.user._id, req.params.provider, req.params.credentialId, req.body || {});
    return send(res, data, "API key updated");
}));

router.delete("/credentials/:provider/:credentialId", byokGate, asyncHandler(async (req, res) => {
    const data = await deleteCredential(req.user._id, req.params.provider, req.params.credentialId);
    return send(res, data, data.deleted ? "API key removed" : "No such API key");
}));

router.delete("/credentials/:provider", byokGate, asyncHandler(async (req, res) => {
    const data = await deleteProviderCredentials(req.user._id, req.params.provider);
    return send(res, data, "API keys removed");
}));

// ── tailoring + chat ───────────────────────────────────────────────────────
const sendTailor = async (req, res) => {
    const result = await tailorResume(req.user, req.body || {});
    return send(res, result, result.requiresManualJD ? "A job description is needed" : "Tailoring suggestions ready");
};

router.post("/tailor", byokGate, requireRole("student"), tailorLimit, asyncHandler(sendTailor));

router.post("/chat", byokGate, tailorLimit, asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, "resumeContent")) {
        // Matchy compat: a body with resumeContent is a tailoring request.
        if (!hasRole(req.user, "student")) throw fail(403, "This action requires one of these roles: student", "FORBIDDEN");
        return sendTailor(req, res);
    }
    return send(res, await chatCompletion(req.user, body), "Completion ready");
}));

// ── per-user job descriptions (work without BYOK) ──────────────────────────
const jobRefParams = (req) => {
    const jobSource = normalizeJobSource(req.params.jobSource);
    if (!jobSource) throw fail(400, "jobSource must be campus or market", "VALIDATION", { field: "jobSource" });
    return { jobSource, jobId: assertObjectId(req.params.jobId, "jobId") };
};

router.get("/job-descriptions/:jobSource/:jobId", asyncHandler(async (req, res) => {
    const job = await resolveJob(jobRefParams(req), { user: req.user });
    const saved = await getSavedJobDescription(req.user, job);
    const own = String(job.description || "").trim();
    const data = saved
        ? { job: publicJob(job), text: saved.text, textSource: "saved", updatedAt: saved.updatedAt }
        : own.length >= JD_MIN_CHARS
            ? { job: publicJob(job), text: own, textSource: "job", updatedAt: null }
            : { job: publicJob(job), text: null, textSource: null, updatedAt: null };
    return send(res, data, "Job description loaded");
}));

router.put("/job-descriptions/:jobSource/:jobId", asyncHandler(async (req, res) => {
    const params = jobRefParams(req);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (text.length < JD_MIN_CHARS || text.length > JD_MAX_CHARS) {
        throw fail(400, `Paste the full job description (${JD_MIN_CHARS}–${JD_MAX_CHARS} characters)`, "VALIDATION", { field: "text" });
    }
    const job = await resolveJob(params, { user: req.user });
    const saved = await saveJobDescription(req.user, job, text);
    return send(res, { job: publicJob(job), text: saved.text, textSource: "saved", updatedAt: saved.updatedAt }, "Job description saved");
}));

router.delete("/job-descriptions/:jobSource/:jobId", asyncHandler(async (req, res) => {
    const { jobSource, jobId } = jobRefParams(req);
    const deleted = await deleteSavedJobDescription(req.user, jobSource, jobId);
    return send(res, { deleted }, deleted ? "Job description removed" : "No saved job description");
}));

export default router;
