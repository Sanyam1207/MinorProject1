import { io as ioClient } from "socket.io-client";
import { AI_SERVICE_URL } from "../config/config.js";
import { getAuthenticatedUser, getEffectiveRole } from "./auth-context.js";
import { buildRequestMetadata } from "./metadata-builder.js";
import { persistConfirmedJob } from "./job-service.js";
import { recordPROutreachSatisfaction } from "../utils/pr-outreach-session.js";
import { recordAlumniRequestReview } from "../utils/alumni-review-session.js";
import { recordResumeShareReview } from "../utils/resume-share-review-session.js";
import { resolveIntentMode } from "./intent-router.js";
import { saveCompletedInterview, saveInterviewRecommendations } from "../services/interview.service.js";

const emitUnavailable = (io, requestId, closeConnection) => {
    io.to(requestId).emit("response", {
        requestId,
        header_message: "AI backend unreachable",
        response: "",
        isEnd: true,
    });
    closeConnection();
};

const persistJobCreationResponse = async ({ payload, user, sessionId }) => {
    if (payload.header_message !== "mode:jobCreation:post" || !payload.data?.job) return payload;

    try {
        const persistedJob = await persistConfirmedJob({ job: payload.data.job, user, sessionId });
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

export const createAIQueryHandler = (io, { onAgentResponse } = {}) => async function handleAIQuery({
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
} = {}) {
    if (!requestId || !user_query || !user_role || !sessionId) return;

    this.join(requestId);
    const user = await getAuthenticatedUser(this);
    const effectiveRole = getEffectiveRole(user, user_role);
    const resolvedModeName = resolveIntentMode({ query: user_query, modeName: mode_name });
    const meta_data = await buildRequestMetadata({ modeName: resolvedModeName, user, effectiveRole, details });
    const aiConnection = ioClient(AI_SERVICE_URL, {
        transports: ["websocket", "polling"],
        reconnection: false,
    });
    let closed = false;
    const closeConnection = () => {
        if (closed) return;
        closed = true;
        this.leave(requestId);
        aiConnection.disconnect();
    };

    aiConnection.on("connect", () => aiConnection.emit("query", {
        requestId,
        user_query,
        user_role: effectiveRole,
        sessionId,
        mode_name: resolvedModeName,
        past_messages,
        meta_data,
        ...(mail_draft && typeof mail_draft === "object" ? { mail_draft } : {}),
        ...(alumni_request_draft && typeof alumni_request_draft === "object" ? { alumni_request_draft } : {}),
        ...(resume_share_draft && typeof resume_share_draft === "object" ? { resume_share_draft } : {}),
    }));

    aiConnection.on("response", async (incomingPayload) => {
        if (incomingPayload.header_message === "pr_outreach_satisfied") {
            recordPROutreachSatisfaction({
                sessionId,
                userId: user?._id?.toString(),
                confidenceScore: incomingPayload.confidence_score,
            });
        }
        if (incomingPayload.header_message === "alumni:request-review") {
            recordAlumniRequestReview({
                sessionId,
                userId: user?._id?.toString(),
                draft: incomingPayload.data,
            });
        }
        if (incomingPayload.header_message === "alumni:resume-share-review") {
            recordResumeShareReview({
                sessionId,
                userId: user?._id?.toString(),
                draft: incomingPayload.data,
            });
        }
        const jobPayload = await persistJobCreationResponse({ payload: incomingPayload, user, sessionId });
        const interviewPayload = await persistInterviewResponse({
            payload: jobPayload,
            user,
            sessionId,
            requestId,
            details,
        });
        const payload = await persistRecommendationResponse({ payload: interviewPayload, user });
        io.to(requestId).emit("response", payload);
        if (typeof onAgentResponse === "function") {
            Promise.resolve(onAgentResponse({
                socket: this,
                payload,
                requestId,
                sessionId,
                modeName: resolvedModeName,
            })).catch((error) => console.error("Unable to generate interview speech:", error));
        }
        if (payload.isEnd) closeConnection();
    });

    aiConnection.on("connect_error", () => emitUnavailable(io, requestId, closeConnection));
};
