import crypto from "crypto";

const reviews = new Map();

const stableValue = (value) => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = stableValue(value[key]);
            return result;
        }, {});
    }
    return value;
};

const canonicalReview = ({ alumniId, requestType, message, selectedJob, shareResume, resume }) => JSON.stringify(stableValue({
    alumniId: String(alumniId || ""),
    requestType: String(requestType || ""),
    message: String(message || "").trim(),
    selectedJob: selectedJob || null,
    shareResume: Boolean(shareResume),
    resume: shareResume ? String(resume || "") : "",
}));

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const recordAlumniRequestReview = ({ sessionId, userId, draft }) => {
    if (!sessionId || !userId || !draft?.alumni_id) return;
    reviews.set(sessionId, {
        userId: String(userId),
        digest: digest(canonicalReview({
            alumniId: draft.alumni_id,
            requestType: draft.request_type,
            message: draft.message,
            selectedJob: draft.selected_job,
            shareResume: draft.share_resume,
            resume: draft.resume,
        })),
        status: "ready",
        reviewedAt: Date.now(),
    });
};

export const claimAlumniRequestReview = ({ sessionId, userId, request }) => {
    const review = reviews.get(sessionId);
    if (!review) return { ok: false, reason: "missing" };
    if (review.userId !== String(userId)) return { ok: false, reason: "forbidden" };
    if (review.status !== "ready") return { ok: false, reason: review.status };
    if (Date.now() - review.reviewedAt > 30 * 60 * 1000) return { ok: false, reason: "expired" };
    if (review.digest !== digest(canonicalReview(request))) return { ok: false, reason: "changed" };
    review.status = "creating";
    return { ok: true };
};

export const completeAlumniRequestReview = (sessionId) => {
    const review = reviews.get(sessionId);
    if (review) review.status = "created";
};

export const releaseAlumniRequestReview = (sessionId) => {
    const review = reviews.get(sessionId);
    if (review?.status === "creating") review.status = "ready";
};
