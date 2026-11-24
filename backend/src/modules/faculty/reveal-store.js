// One-time reveal of a temporary password (docs/contracts/AUTH-FACULTY.md §7.5).
//
// Copilot tools never put a temporary password into a tool result (it would
// reach the LLM). Instead the tool stores it here and returns an opaque
// `revealId`; the TPO's Faculty/Recruiters panel redeems it once through
// POST /api/v1/faculty/reveal. In-memory, 10-minute TTL, single process.
import crypto from "node:crypto";

export const REVEAL_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

const entries = new Map();

const sweep = (now = Date.now()) => {
    for (const [id, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(id);
    }
};

/** Store a temporary password for `ownerId`; returns the revealId (16 random bytes, base64url). */
export const putReveal = ({ ownerId, email, password }) => {
    const now = Date.now();
    sweep(now);
    while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
    const revealId = crypto.randomBytes(16).toString("base64url");
    entries.set(revealId, {
        ownerId: String(ownerId),
        email,
        password,
        expiresAt: now + REVEAL_TTL_MS,
    });
    return revealId;
};

/**
 * `{email, temporaryPassword}` once, for the owner only; null when missing,
 * expired or owned by someone else (a wrong owner does not consume it).
 */
export const takeReveal = (revealId, ownerId) => {
    if (typeof revealId !== "string" || !revealId || revealId.length > 64) return null;
    const entry = entries.get(revealId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        entries.delete(revealId);
        return null;
    }
    if (entry.ownerId !== String(ownerId)) return null;
    entries.delete(revealId);
    return { email: entry.email, temporaryPassword: entry.password };
};

/** TEST HOOK. */
export const clearReveals = () => entries.clear();
