// Rotating single-use QR tokens (ATTENDANCE.md "Rotating QR — security rules").
//
// The token is `qr.nonce` of a live session. It dies when it is consumed by a
// successful scan (one atomic findOneAndUpdate swaps in a new nonce) or when
// `qr.expiresAt` passes (the 1 s ticker, GET /sessions/:id/qr and presenter
// join rotate expired tokens with the same atomic pattern).
import crypto from "node:crypto";
import { DEFAULT_SETTINGS, frontendUrl } from "./config.js";
import { emitQr } from "./events.js";
import { ClassSession } from "./models/index.js";
import { idString } from "./serializers.js";

export const newNonce = () => crypto.randomBytes(16).toString("base64url");

export const rotationSecondsOf = (session) => session?.qr?.rotationSeconds || DEFAULT_SETTINGS.qrRotationSeconds;

export const buildQrUrl = (sessionId, token, version) =>
    `${frontendUrl()}/attend?s=${encodeURIComponent(idString(sessionId))}&t=${encodeURIComponent(token)}&v=${version}`;

/** QR payload for the presenter (REST + socket). `session` must include `qr.nonce`. */
export const qrPayload = (session) => ({
    sessionId: idString(session._id),
    token: session.qr.nonce,
    version: session.qr.version,
    expiresAt: session.qr.expiresAt,
    url: buildQrUrl(session._id, session.qr.nonce, session.qr.version),
    rotationSeconds: rotationSecondsOf(session),
});

/** `$set` fields of a fresh token. */
export const freshTokenFields = (rotationSeconds, now = new Date()) => ({
    "qr.nonce": newNonce(),
    "qr.issuedAt": now,
    "qr.expiresAt": new Date(now.getTime() + rotationSeconds * 1000),
});

/**
 * Consume `token` atomically: exactly one concurrent caller gets the updated
 * session (with the NEW nonce); everyone else gets null.
 */
export const consumeToken = (sessionId, token, rotationSeconds, now = new Date()) => ClassSession.findOneAndUpdate(
    { _id: sessionId, status: "live", "qr.nonce": token, "qr.expiresAt": { $gt: now } },
    { $set: freshTokenFields(rotationSeconds, now), $inc: { "qr.version": 1 } },
    { returnDocument: "after" },
).select("+qr.nonce");

/**
 * Rotate the token of a live session only if it has expired, then push it to
 * the presenter room.
 * @returns {Promise<{session: object|null, rotated: boolean}>} session = the live
 *   session with its current nonce (null when the session is not live)
 */
export const rotateIfExpired = async (sessionId, now = new Date()) => {
    const current = await ClassSession.findOne({ _id: sessionId, status: "live" }).select("+qr.nonce");
    if (!current) return { session: null, rotated: false };
    if (current.qr?.nonce && current.qr.expiresAt && current.qr.expiresAt > now) return { session: current, rotated: false };
    const rotationSeconds = rotationSecondsOf(current);
    const rotated = await ClassSession.findOneAndUpdate(
        {
            _id: sessionId,
            status: "live",
            $or: [{ "qr.expiresAt": { $lte: now } }, { "qr.expiresAt": null }, { "qr.nonce": null }],
        },
        { $set: { ...freshTokenFields(rotationSeconds, now), "qr.rotationSeconds": rotationSeconds }, $inc: { "qr.version": 1 } },
        { returnDocument: "after" },
    ).select("+qr.nonce");
    if (rotated) {
        emitQr(qrPayload(rotated));
        return { session: rotated, rotated: true };
    }
    // A scan or the ticker rotated it meanwhile (and pushed it to the presenter).
    return { session: await ClassSession.findOne({ _id: sessionId, status: "live" }).select("+qr.nonce"), rotated: false };
};

/** Background ticker body: rotate every expired token of every live session. */
export const rotateExpiredTokens = async (now = new Date()) => {
    const due = await ClassSession.find({ status: "live", "qr.expiresAt": { $lte: now } }).select("_id").lean();
    let count = 0;
    for (const { _id } of due) {
        const { rotated } = await rotateIfExpired(_id, now);
        if (rotated) count += 1;
    }
    return count;
};
