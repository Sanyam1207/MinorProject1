const MINIMUM_SEND_CONFIDENCE = 0.85;

const outreachSessions = new Map();

const normalizeConfidence = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const normalized = parsed > 1 ? parsed / 100 : parsed;
    return Math.max(0, Math.min(1, normalized));
};

export const recordPROutreachSatisfaction = ({ sessionId, userId, confidenceScore }) => {
    const confidence = normalizeConfidence(confidenceScore);
    if (!sessionId || !userId || confidence === null) return;

    outreachSessions.set(sessionId, {
        userId: String(userId),
        confidence,
        satisfiedAt: Date.now(),
        sendStatus: "ready",
        messageId: null,
    });
};

export const claimPROutreachSend = ({ sessionId, userId }) => {
    const record = outreachSessions.get(sessionId);
    if (!record) return { ok: false, reason: "missing" };
    if (record.userId !== String(userId)) return { ok: false, reason: "forbidden" };
    if (record.confidence <= MINIMUM_SEND_CONFIDENCE) {
        return { ok: false, reason: "confidence", confidence: record.confidence };
    }
    if (record.sendStatus === "sending") return { ok: false, reason: "sending" };
    if (record.sendStatus === "sent") {
        return { ok: false, reason: "sent", messageId: record.messageId };
    }

    record.sendStatus = "sending";
    return { ok: true, confidence: record.confidence };
};

export const completePROutreachSend = ({ sessionId, messageId }) => {
    const record = outreachSessions.get(sessionId);
    if (!record) return;
    record.sendStatus = "sent";
    record.messageId = messageId || null;
};

export const releasePROutreachSend = (sessionId) => {
    const record = outreachSessions.get(sessionId);
    if (record?.sendStatus === "sending") record.sendStatus = "ready";
};

export { MINIMUM_SEND_CONFIDENCE };
