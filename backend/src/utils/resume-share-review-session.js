import crypto from "crypto";

const reviews = new Map();
const digest = ({ connectionId, resumeVersionId, message }) => crypto.createHash("sha256")
    .update(JSON.stringify({ connectionId: String(connectionId || ""), resumeVersionId: String(resumeVersionId || ""), message: String(message || "").trim() }))
    .digest("hex");

export const recordResumeShareReview = ({ sessionId, userId, draft }) => {
    if (!sessionId || !userId || !draft?.connection_id || !draft?.resume_version_id) return;
    reviews.set(sessionId, { userId: String(userId), digest: digest({ connectionId: draft.connection_id, resumeVersionId: draft.resume_version_id, message: draft.message }), status: "ready", reviewedAt: Date.now() });
};

export const claimResumeShareReview = ({ sessionId, userId, request }) => {
    const review = reviews.get(sessionId);
    if (!review) return { ok: false, reason: "missing" };
    if (review.userId !== String(userId)) return { ok: false, reason: "forbidden" };
    if (review.status !== "ready") return { ok: false, reason: review.status };
    if (Date.now() - review.reviewedAt > 30 * 60 * 1000) return { ok: false, reason: "expired" };
    if (review.digest !== digest(request)) return { ok: false, reason: "changed" };
    review.status = "sharing";
    return { ok: true };
};

export const completeResumeShareReview = (sessionId) => { const review = reviews.get(sessionId); if (review) review.status = "shared"; };
export const releaseResumeShareReview = (sessionId) => { const review = reviews.get(sessionId); if (review?.status === "sharing") review.status = "ready"; };
