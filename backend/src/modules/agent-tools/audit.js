// Writing and reading the AgentToolCall audit trail.
import mongoose from "mongoose";
import { fail, intParam, isObjectId } from "../../core/http.js";
import { User } from "../../models/user.models.js";
import { AgentToolCall } from "./agent-tool-call.model.js";
import { isPlainObject } from "./validate.js";

const MAX_STRING = 500;
const MAX_ITEMS = 25;
const MAX_KEYS = 40;
const MAX_DEPTH = 4;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Keys that end like a credential are never stored (e.g. apiKey, accessToken, password).
const SENSITIVE_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie)$/i;

const clip = (value, max) => {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
};

// MongoDB field names must not start with "$" or contain ".".
const safeKey = (key) => key.replace(/^\$+/, "_").replace(/\./g, "_").slice(0, 64);

/** Bounded, credential-free copy of tool arguments for the audit record. */
export const auditSafe = (value, depth = 0) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (+${value.length - MAX_STRING} chars)` : value;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === "object" && typeof value.toHexString === "function") return value.toHexString();
    if (depth >= MAX_DEPTH) return "[nested]";
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ITEMS).map((item) => auditSafe(item, depth + 1));
        if (value.length > MAX_ITEMS) items.push(`… +${value.length - MAX_ITEMS} more`);
        return items;
    }
    if (typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
            if (FORBIDDEN_KEYS.has(key)) continue;
            out[safeKey(key)] = SENSITIVE_KEY.test(key) ? "[redacted]" : auditSafe(item, depth + 1);
        }
        return out;
    }
    return clip(value, MAX_STRING);
};

/**
 * Append one execution to the audit trail. Never throws: a failed audit write
 * is logged and the tool answer is still returned.
 */
export const recordToolCall = async ({ ctx, toolName, module = null, args, result, confirmed, durationMs }) => {
    try {
        const ok = result?.ok === true;
        let error = null;
        let message = null;
        if (result?.needs_confirmation === true) {
            error = "NEEDS_CONFIRMATION";
            message = clip(result.preview, 300);
        } else if (!ok) {
            error = clip(result?.error || "ERROR", 64);
            message = clip(result?.message, 300);
        }
        await AgentToolCall.create({
            user: ctx.user._id,
            college: ctx.user.college ?? null,
            role: ctx.role ?? null,
            tool: clip(toolName || "(none)", 64),
            module,
            args: isPlainObject(args) ? auditSafe(args) : args === undefined ? {} : { value: auditSafe(args) },
            ok,
            error,
            message,
            durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
            requestId: clip(ctx.requestId, 200),
            sessionId: clip(ctx.sessionId, 200),
            confirmed: confirmed === true,
        });
    } catch (error) {
        console.error("[agent-tools] could not write the audit record:", error?.message || error);
    }
};

const firstValue = (value) => (Array.isArray(value) ? value[0] : value);

const toAuditView = (entry, user) => ({
    id: String(entry._id),
    user: user
        ? { id: String(user._id), name: user.name ?? null, email: user.email ?? null, role: user.role ?? null }
        : { id: String(entry.user) },
    role: entry.role ?? null,
    tool: entry.tool,
    module: entry.module ?? null,
    args: entry.args ?? {},
    ok: Boolean(entry.ok),
    error: entry.error ?? null,
    message: entry.message ?? null,
    durationMs: entry.durationMs ?? 0,
    requestId: entry.requestId ?? null,
    sessionId: entry.sessionId ?? null,
    confirmed: Boolean(entry.confirmed),
    createdAt: entry.createdAt,
});

/**
 * GET /audit: newest first, paginated. Filters: `tool` (exact name), `user`
 * (id or email), `ok` (true/false). A TPO only sees calls made by users of
 * their own college (users without a college when the TPO has none); admin
 * sees everything.
 */
export const listAuditEntries = async (viewer, query = {}) => {
    const filter = {};
    if (viewer.role !== "admin") filter.college = viewer.college ?? null;

    const page = intParam(firstValue(query.page), { min: 1, max: 100_000, fallback: 1 });
    const limit = intParam(firstValue(query.limit), { min: 1, max: 200, fallback: 50 });
    const empty = { items: [], total: 0, page, limit, hasNextPage: false };

    const tool = firstValue(query.tool);
    if (typeof tool === "string" && tool.trim()) filter.tool = tool.trim().toLowerCase().slice(0, 64);

    const ok = firstValue(query.ok);
    if (typeof ok === "string" && ok.trim()) {
        const flag = ok.trim().toLowerCase();
        if (["true", "1", "yes"].includes(flag)) filter.ok = true;
        else if (["false", "0", "no"].includes(flag)) filter.ok = false;
        else throw fail(400, "ok must be true or false", "VALIDATION", { field: "ok" });
    }

    const userRef = firstValue(query.user);
    if (typeof userRef === "string" && userRef.trim()) {
        const ref = userRef.trim();
        if (isObjectId(ref)) {
            filter.user = new mongoose.Types.ObjectId(ref);
        } else if (ref.includes("@")) {
            const match = await User.findOne({ email: ref.toLowerCase() }).select("_id").lean();
            if (!match) return empty;
            filter.user = match._id;
        } else {
            throw fail(400, "user must be a user id or an email address", "VALIDATION", { field: "user" });
        }
    }

    const [entries, total] = await Promise.all([
        AgentToolCall.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        AgentToolCall.countDocuments(filter),
    ]);
    const userIds = [...new Set(entries.map((entry) => String(entry.user)))];
    const users = userIds.length
        ? await User.find({ _id: { $in: userIds } }).select("name email role").lean()
        : [];
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    return {
        items: entries.map((entry) => toAuditView(entry, usersById.get(String(entry.user)))),
        total,
        page,
        limit,
        hasNextPage: page * limit < total,
    };
};
