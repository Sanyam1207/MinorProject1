import { io as ioClient } from "socket.io-client";
import jwt from "jsonwebtoken";
import {
    AI_SERVICE_URL,
    AI_SERVICE_TOKEN,
    AGENT_TOOL_SECRET,
    AGENT_TOOL_TOKEN_TTL,
    APP_TIMEZONE,
    INTERNAL_API_URL,
} from "../config/config.js";
import { getAuthenticatedUser, getEffectiveRole } from "./auth-context.js";
import { buildRequestMetadata } from "./metadata-builder.js";
import { persistConfirmedJob } from "./job-service.js";
import { recordPROutreachSatisfaction } from "../utils/pr-outreach-session.js";
import { recordAlumniRequestReview } from "../utils/alumni-review-session.js";
import { recordResumeShareReview } from "../utils/resume-share-review-session.js";
import { resolveIntentMode } from "./intent-router.js";
import { saveCompletedInterview, saveInterviewRecommendations } from "../services/interview.service.js";

// Longest silence tolerated from the AI service before the relay gives up on
// a request (multi-step agents can take a while between chunks).
const AI_IDLE_TIMEOUT_MS = Math.max(15_000, Number(process.env.AI_IDLE_TIMEOUT_MS) || 120_000);
const MAX_QUERY_CHARS = 8_000;

// Identity + short-lived credential the Python copilot uses to call
// /api/v1/agent-tools as this user (docs/contracts/AGENT-TOOLS.md §1).
const buildAgentContext = ({ user, effectiveRole, requestId, sessionId }) => {
    const context = {
        actor: user ? {
            user_id: user._id.toString(),
            role: user.role === "admin" ? "admin" : effectiveRole,
            name: user.name || "",
            email: user.email || "",
        } : null,
        tools_url: `${INTERNAL_API_URL}/api/v1/agent-tools`,
        now: new Date().toISOString(),
        timezone: APP_TIMEZONE,
    };
    if (user && AGENT_TOOL_SECRET) {
        context.tool_token = jwt.sign(
            { sub: user._id.toString(), role: user.role, rid: requestId, sid: sessionId, typ: "agent-tool" },
            AGENT_TOOL_SECRET,
            { expiresIn: AGENT_TOOL_TOKEN_TTL },
        );
    }
    return context;
};

// What the user is looking at in the right-hand workspace, so the copilot can
// resolve "this course" / "this job" (PYTHON.md §9). Only small id-like params.
const sanitizeUiContext = (value) => {
    if (!value || typeof value !== "object") return undefined;
    const panel = typeof value.panel === "string" ? value.panel.slice(0, 64) : null;
    const mode = typeof value.mode === "string" ? value.mode.slice(0, 32) : null;
    const params = {};
    if (value.params && typeof value.params === "object") {
        for (const [key, raw] of Object.entries(value.params).slice(0, 20)) {
            if (typeof raw === "string" && raw.length <= 200) params[key.slice(0, 40)] = raw;
            else if (typeof raw === "number" || typeof raw === "boolean") params[key.slice(0, 40)] = raw;
        }
    }
    return panel || mode ? { panel, mode, params } : undefined;
};

const terminalChunk = (requestId, header_message, response, data = { type: "error" }) => ({
    requestId,
    header_message,
    response,
    data,
    isEnd: true,
});

const persistJobCreationResponse = async ({ payload, user, sessionId }) => {
    if (payload.header_message !== "mode:jobCreation:post" || !payload.data?.job) return payload;

    try {
        const persistedJob = await persistConfirmedJob({ job: payload.data.job, user, sessionId, draftId: payload.data?.draft_id });
        return {
            ...payload,
            data: { ...payload.data, persisted_job_id: persistedJob._id.toString() },
        };
    } catch (error) {
        console.error("Unable to persist confirmed AI-created job:", error);
        return {
            ...payload,
            header_message: "mode:jobCreation:error",
            response: `The job draft is complete, but it could not be saved: ${error.message}`,
            data: { ...payload.data, type: "error", status: "error" },
            isEnd: true,
        };
    }
};

const persistInterviewResponse = async ({ payload, user, sessionId, requestId, details }) => {
    if (payload.header_message !== "interview:end" || payload.data?.type !== "interview_report") return payload;
    try {
        const interview = await saveCompletedInterview({ payload, user, sessionId, requestId, details });
        return interview ? {
            ...payload,
            data: {
                ...payload.data,
                interview_id: interview._id.toString(),
                saved: true,
            },
        } : payload;
    } catch (error) {
        console.error("Unable to persist completed interview:", error);
        return {
            ...payload,
            data: {
                ...payload.data,
                saved: false,
            },
        };
    }
};

const persistRecommendationResponse = async ({ payload, user }) => {
    if (payload.header_message !== "learning:recommendations" || payload.data?.type !== "learning_recommendations") return payload;
    try {
        const interview = await saveInterviewRecommendations({ payload, user });
        return {
            ...payload,
            data: {
                ...payload.data,
                saved: Boolean(interview),
            },
        };
    } catch (error) {
        console.error("Unable to persist interview recommendations:", error);
        return {
            ...payload,
            data: { ...payload.data, saved: false },
        };
    }
};

/**
 * Relays one chat query from the browser to the Python agent service and
 * streams every response chunk back to the SAME socket.
 *
 * Guarantees: exactly one terminal (isEnd) chunk reaches the browser for every
 * accepted request — on success, AI-service failure, disconnect or timeout —
 * and chunks are relayed strictly in arrival order even though some trigger
 * asynchronous persistence.
 */
export const createAIQueryHandler = (_io, { onAgentResponse } = {}) => async function handleAIQuery(payload = {}) {
    const socket = this;
    const {
        requestId,
        user_query,
        user_role,
        sessionId,
        mode_name,
        details = {},
        past_messages,
        mail_draft,
        alumni_request_draft,
        resume_share_draft,
    } = payload || {};

    if (!requestId || typeof requestId !== "string") return;
    const emit = (message) => socket.emit("response", message);

    if (!user_query || !sessionId || typeof user_query !== "string" || typeof sessionId !== "string") {
        emit(terminalChunk(requestId, "invalid request", "Your message could not be processed. Please try again."));
        return;
    }

    let user = null;
    try {
        user = await getAuthenticatedUser(socket);
    } catch {
        user = null;
    }
    if (!user) {
        emit(terminalChunk(requestId, "auth:required", "Your session has expired. Please sign in again to use the assistant.", { type: "error", code: "AUTH_REQUIRED" }));
        return;
    }

    const query = user_query.slice(0, MAX_QUERY_CHARS);
    const effectiveRole = getEffectiveRole(user, user_role);
    const requestedMode = typeof mode_name === "string" && mode_name.trim() ? mode_name.trim() : null;
    // The regex intent router only chooses the mode for a turn that has none.
    // Inside an active workflow the Python orchestrator decides (stricter
    // switch rules + agent hooks), so Node never hijacks e.g. interview answers.
    const suggestedMode = resolveIntentMode({ query, modeName: requestedMode, role: user.role === "admin" ? "admin" : effectiveRole });
    const forwardedMode = requestedMode || suggestedMode || null;

    let meta_data;
    try {
        const base = await buildRequestMetadata({ modeName: forwardedMode, user, effectiveRole, details });
        // When the words point at another agent, pre-load that agent's context
        // too, so a switch decided in Python still has the data it needs.
        const extra = requestedMode && suggestedMode && suggestedMode !== requestedMode
            ? await buildRequestMetadata({ modeName: suggestedMode, user, effectiveRole, details }).catch(() => ({}))
            : {};
        meta_data = {
            ...extra,
            ...base,
            ...buildAgentContext({ user, effectiveRole, requestId, sessionId }),
        };
        const uiContext = sanitizeUiContext(details?.ui_context);
        if (uiContext) meta_data.ui_context = uiContext;
        if (!meta_data.selected_job && details?.selected_job && typeof details.selected_job === "object") {
            meta_data.selected_job = details.selected_job;
        }
    } catch (error) {
        console.error("Unable to build agent metadata:", error);
        emit(terminalChunk(requestId, "error", "I could not load your data right now. Please try again in a moment."));
        return;
    }

    const aiConnection = ioClient(AI_SERVICE_URL, {
        transports: ["websocket", "polling"],
        reconnection: false,
        timeout: 10_000,
        ...(AI_SERVICE_TOKEN ? { auth: { token: AI_SERVICE_TOKEN } } : {}),
    });

    let closed = false;
    let ended = false;
    let idleTimer = null;

    const onClientDisconnect = () => cleanup();
    const cleanup = () => {
        if (closed) return;
        closed = true;
        clearTimeout(idleTimer);
        socket.off("disconnect", onClientDisconnect);
        aiConnection.removeAllListeners();
        aiConnection.disconnect();
    };
    const finishWithError = (header, message) => {
        if (!ended) {
            ended = true;
            emit(terminalChunk(requestId, header, message));
        }
        cleanup();
    };
    const armIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
            () => finishWithError("AI backend timeout", "The assistant took too long to respond. Please try again."),
            AI_IDLE_TIMEOUT_MS,
        );
        idleTimer.unref?.();
    };

    socket.once("disconnect", onClientDisconnect);
    armIdleTimer();

    aiConnection.on("connect", () => aiConnection.emit("query", {
        requestId,
        user_query: query,
        user_role: effectiveRole,
        // Python keeps per-session state in memory; namespacing by user stops a
        // guessed sessionId from ever reaching another user's workflow state.
        sessionId: `${user._id.toString()}:${sessionId}`,
        mode_name: forwardedMode,
        past_messages: Array.isArray(past_messages) ? past_messages.slice(-12) : undefined,
        meta_data,
        ...(mail_draft && typeof mail_draft === "object" ? { mail_draft } : {}),
        ...(alumni_request_draft && typeof alumni_request_draft === "object" ? { alumni_request_draft } : {}),
        ...(resume_share_draft && typeof resume_share_draft === "object" ? { resume_share_draft } : {}),
    }));

    aiConnection.on("connect_error", () => finishWithError(
        "AI backend unreachable",
        "The AI service is not reachable right now. Please make sure it is running and try again.",
    ));
    aiConnection.on("disconnect", () => {
        if (!ended) finishWithError("AI backend disconnected", "The AI service stopped responding. Please try again.");
    });

    const relay = async (incomingPayload) => {
        if (ended || !incomingPayload || typeof incomingPayload !== "object") return;
        armIdleTimer();

        const userId = user._id.toString();
        if (incomingPayload.header_message === "pr_outreach_satisfied") {
            recordPROutreachSatisfaction({
                sessionId,
                userId,
                confidenceScore: incomingPayload.confidence_score,
            });
        }
        if (incomingPayload.header_message === "alumni:request-review") {
            recordAlumniRequestReview({ sessionId, userId, draft: incomingPayload.data });
        }
        if (incomingPayload.header_message === "alumni:resume-share-review") {
            recordResumeShareReview({ sessionId, userId, draft: incomingPayload.data });
        }
        const jobPayload = await persistJobCreationResponse({ payload: incomingPayload, user, sessionId });
        const interviewPayload = await persistInterviewResponse({
            payload: jobPayload,
            user,
            sessionId,
            requestId,
            details,
        });
        const persisted = await persistRecommendationResponse({ payload: interviewPayload, user });
        // Never let the agent service rewrite the browser's identifiers.
        const outgoing = { ...persisted, requestId, sessionId };
        if (ended) return;
        emit(outgoing);
        if (typeof onAgentResponse === "function") {
            Promise.resolve(onAgentResponse({
                socket,
                payload: outgoing,
                requestId,
                sessionId,
                modeName: forwardedMode,
            })).catch((error) => console.error("Unable to generate interview speech:", error));
        }
        if (outgoing.isEnd) {
            ended = true;
            cleanup();
        }
    };

    // Persistence hooks are async: chain chunks so they reach the browser in order.
    let chain = Promise.resolve();
    aiConnection.on("response", (incomingPayload) => {
        chain = chain
            .then(() => relay(incomingPayload))
            .catch((error) => {
                console.error("Unable to relay agent response:", error);
                finishWithError("error", "Something went wrong while delivering the assistant's answer.");
            });
    });
};
