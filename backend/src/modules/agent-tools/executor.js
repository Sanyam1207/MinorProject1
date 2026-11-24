// Manifest and execution of copilot tools as the signed-in user
// (docs/contracts/AGENT-TOOLS.md §3). Tool failures are data for the LLM:
// every outcome here is a plain object that the route sends with HTTP 200.
//
//   success            {ok:true, tool, summary, data, ui?}
//   confirm first      {ok:false, needs_confirmation:true, tool, args, preview}
//   failure            {ok:false, tool?, error, message, details?}
//                      error ∈ VALIDATION | UNKNOWN_TOOL | FORBIDDEN | AMBIGUOUS (+ candidates)
//                              | INTERNAL | the ApiError code (errors[0].code) | "ERROR"
import { APP_TIMEZONE } from "../../config/config.js";
import { ApiError } from "../../utils/api-error.js";
import { recordToolCall } from "./audit.js";
import { ROLE_LABELS } from "./constants.js";
import { warnOnce } from "./log.js";
import { canUseTool, getToolRegistry, resolveParameters } from "./registry.js";
import { formatValidationMessage, isPlainObject, toJsonSafe, validateArgs } from "./validate.js";

const MAX_TEXT = 2000;
const MAX_PREVIEW = 600;
const MAX_CANDIDATES = 20;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const clip = (value, max) => {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** `ctx` handed to every parameters function, preview and handler. */
export const buildToolContext = ({ user, requestId = null, sessionId = null, now = new Date() }) => ({
    user,
    role: user?.role ?? null,
    requestId,
    sessionId,
    now,
    timezone: APP_TIMEZONE,
});

const failure = (tool, error, message, details) => {
    const result = { ok: false };
    if (tool) result.tool = tool;
    result.error = error;
    result.message = message;
    if (details !== undefined) result.details = details;
    return result;
};

const isAmbiguous = (output) => Boolean(output) && typeof output === "object" && output.ambiguous === true;

// A tool may also report failure by returning {ok:false, error, message} instead of throwing.
const isExplicitFailure = (output) => Boolean(output) && typeof output === "object" && !Array.isArray(output)
    && output.ok === false;

const normaliseCandidates = (list) => {
    if (!Array.isArray(list)) return [];
    const candidates = [];
    for (const entry of list) {
        if (candidates.length >= MAX_CANDIDATES) break;
        if (entry === null || entry === undefined) continue;
        if (typeof entry !== "object") {
            candidates.push({ id: String(entry), label: String(entry) });
            continue;
        }
        const rawId = entry.id ?? entry._id ?? entry.value;
        if (rawId === undefined || rawId === null || rawId === "") continue;
        const id = String(rawId);
        const candidate = { id, label: String(entry.label ?? entry.name ?? entry.title ?? id) };
        for (const [key, value] of Object.entries(entry)) {
            if (Object.hasOwn(candidate, key) || key === "_id" || FORBIDDEN_KEYS.has(key)) continue;
            if (["string", "number", "boolean"].includes(typeof value)) candidate[key] = value;
        }
        candidates.push(candidate);
    }
    return candidates;
};

const ambiguousResult = (tool, output) => ({
    ok: false,
    tool: tool.name,
    error: "AMBIGUOUS",
    message: clip(text(output.message) || "Several items match. Which one do you mean?", MAX_TEXT),
    candidates: normaliseCandidates(output.candidates),
});

const explicitFailure = (tool, output) => failure(
    tool.name,
    text(output.error) || "ERROR",
    clip(text(output.message) || "The tool could not complete the request.", MAX_TEXT),
    output.details === undefined ? undefined : toJsonSafe(output.details),
);

const isUiAction = (action) => Boolean(action) && typeof action === "object" && !Array.isArray(action)
    && typeof action.panel === "string" && action.panel.trim() !== "";

const cleanUiAction = (action) => {
    const clean = { ...action, panel: action.panel.trim() };
    if (clean.params !== undefined && !isPlainObject(clean.params)) delete clean.params;
    return clean;
};

/** `ui` as object | non-empty array | undefined; malformed entries are dropped (their `data` is kept). */
const normaliseUi = (ui, toolName) => {
    if (ui === undefined || ui === null) return undefined;
    if (Array.isArray(ui)) {
        const actions = ui.filter(isUiAction).map(cleanUiAction);
        if (actions.length !== ui.length) warnOnce(`ui:${toolName}`, `tool "${toolName}" returned ui entries without a panel; they were dropped`);
        return actions.length ? actions : undefined;
    }
    if (isUiAction(ui)) return cleanUiAction(ui);
    warnOnce(`ui:${toolName}`, `tool "${toolName}" returned an invalid ui value; it was dropped`);
    return undefined;
};

const toToolResult = (tool, output) => {
    if (isAmbiguous(output)) return ambiguousResult(tool, output);
    if (isExplicitFailure(output)) return explicitFailure(tool, output);
    const body = output && typeof output === "object" && !Array.isArray(output) ? output : {};
    const summary = text(typeof output === "string" ? output : body.summary) || "Done.";
    const result = {
        ok: true,
        tool: tool.name,
        summary: clip(summary, MAX_TEXT),
        data: body.data === undefined ? null : body.data,
    };
    const ui = normaliseUi(body.ui, tool.name);
    if (ui !== undefined) result.ui = ui;
    return result;
};

const humanise = (toolName) => toolName.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());

const firstSentence = (description) => {
    const value = text(description);
    if (!value) return null;
    const match = /^(.+?[.!?])(?:\s|$)/.exec(value);
    const sentence = (match ? match[1] : value).replace(/[.!?]+$/, "").trim();
    return sentence ? clip(sentence, 160) : null;
};

const formatArgValue = (value) => {
    if (typeof value === "string") return `"${clip(value, 80)}"`;
    if (Array.isArray(value)) {
        return clip(value.map((item) => (item && typeof item === "object" ? JSON.stringify(item) : String(item))).join(", "), 120);
    }
    if (value && typeof value === "object") return clip(JSON.stringify(value), 120);
    return String(value);
};

/** Confirmation text for a tool without its own preview: description + arguments. */
export const genericPreview = (tool, args) => {
    const action = firstSentence(tool.description) || humanise(tool.name);
    const details = Object.entries(args ?? {})
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .slice(0, 10)
        .map(([key, value]) => `${key}: ${formatArgValue(value)}`);
    return clip(details.length ? `${action} — ${details.join(", ")}?` : `${action}?`, MAX_PREVIEW);
};

const previewText = (output) => {
    if (typeof output === "string") return text(output);
    if (!output || typeof output !== "object") return null;
    return text(output.summary) || text(output.preview) || text(output.message);
};

const requestConfirmation = async (tool, schema, args, ctx, trace) => {
    let preview = null;
    let normalised = args;
    if (tool.preview) {
        const output = await tool.preview(args, ctx);
        if (isAmbiguous(output)) return ambiguousResult(tool, output);
        // A preview shaped like a needs_confirmation answer is a preview, not a failure.
        if (isExplicitFailure(output) && output.needs_confirmation !== true) return explicitFailure(tool, output);
        preview = previewText(output);
        if (output && typeof output === "object" && output.args !== undefined) {
            // The preview may resolve fuzzy references to ids. Its args must pass
            // the tool's own schema, so the confirmed re-run accepts them unchanged.
            const checked = validateArgs(schema, output.args);
            if (checked.ok) normalised = checked.value;
            else {
                warnOnce(
                    `preview-args:${tool.name}`,
                    `the preview of "${tool.name}" returned args that fail its own schema (${formatValidationMessage(tool.name, checked.errors)}); the validated input args are returned instead`,
                );
            }
        }
    }
    trace.args = normalised;
    return {
        ok: false,
        needs_confirmation: true,
        tool: tool.name,
        args: normalised,
        preview: clip(preview || genericPreview(tool, normalised), MAX_TEXT),
    };
};

const errorDetails = (errors) => {
    if (!Array.isArray(errors) || errors.length === 0) return undefined;
    const informative = errors.length > 1 || Object.keys(errors[0] ?? {}).some((key) => key !== "code");
    return informative ? toJsonSafe(errors) : undefined;
};

/** Map an exception thrown by a parameters function, preview or handler to a tool result. */
export const mapToolError = (error, toolName, ctx) => {
    const tool = toolName || undefined;
    const isApiError = error instanceof ApiError
        || (Boolean(error) && Number.isInteger(error.statusCode) && Array.isArray(error.errors));
    if (isApiError) {
        if (error.statusCode >= 500) {
            console.error(`[agent-tools] tool "${toolName}" raised a server error (request ${ctx?.requestId ?? "-"}):`, error);
        }
        const code = text(error.errors?.[0]?.code) || "ERROR";
        return failure(tool, code, clip(text(error.message) || "The request could not be completed.", MAX_TEXT), errorDetails(error.errors));
    }
    if (error?.name === "CastError") return failure(tool, "VALIDATION", `Invalid ${error.path || "value"}.`);
    if (error?.name === "ValidationError") return failure(tool, "VALIDATION", clip(error.message, MAX_TEXT));
    if (error?.code === 11000) return failure(tool, "DUPLICATE", "A record with these details already exists.");
    console.error(`[agent-tools] tool "${toolName || "(none)"}" failed (request ${ctx?.requestId ?? "-"}):`, error);
    return failure(tool, "INTERNAL", "Tool failed");
};

const runTool = async (ctx, toolName, rawArgs, confirmed, trace) => {
    if (!toolName) {
        return failure(undefined, "VALIDATION", "Name the tool to run in `tool`.", [
            { field: "tool", code: "REQUIRED", message: "tool is required" },
        ]);
    }
    const registry = await getToolRegistry();
    const tool = registry.get(toolName);
    if (!tool) return failure(clip(toolName, 64), "UNKNOWN_TOOL", `There is no tool named "${clip(toolName, 64)}".`);
    trace.tool = tool;
    if (!canUseTool(tool, ctx.role)) {
        return failure(tool.name, "FORBIDDEN", `${tool.name} is not available to a ${ROLE_LABELS[ctx.role] || ctx.role || "user"}.`);
    }
    const schema = resolveParameters(tool, ctx);
    const validation = validateArgs(schema, rawArgs);
    if (!validation.ok) {
        return failure(tool.name, "VALIDATION", formatValidationMessage(tool.name, validation.errors), validation.errors);
    }
    trace.args = validation.value;
    if (tool.confirm && !confirmed) return requestConfirmation(tool, schema, validation.value, ctx, trace);
    const output = await tool.handler(validation.value, ctx);
    return toToolResult(tool, output);
};

/**
 * Execute one tool call for `ctx.user` and append it to the audit trail.
 * `confirmed` counts only when it is the boolean `true`. Never throws.
 * @param {object} ctx from buildToolContext()
 * @param {{tool?: string, args?: object, confirmed?: boolean}} body
 */
export const executeTool = async (ctx, body = {}) => {
    const startedAt = Date.now();
    const request = isPlainObject(body) ? body : {};
    // Tool names are lower snake case (TOOL_NAME_RE), so matching is case-insensitive.
    const toolName = typeof request.tool === "string" ? request.tool.trim().toLowerCase() : "";
    const confirmed = request.confirmed === true;
    const trace = { tool: null, args: request.args };
    let result;
    try {
        result = await runTool(ctx, toolName, request.args, confirmed, trace);
    } catch (error) {
        result = mapToolError(error, trace.tool?.name || toolName, ctx);
    }
    await recordToolCall({
        ctx,
        toolName: trace.tool?.name || toolName,
        module: trace.tool?.module ?? null,
        args: trace.args,
        result,
        confirmed,
        durationMs: Date.now() - startedAt,
    });
    return result;
};

/** `{role, tools:[{name, description, parameters, confirm}]}` for the caller's role. */
export const buildManifest = async (ctx) => {
    const registry = await getToolRegistry();
    const tools = [];
    for (const tool of registry.values()) {
        if (!canUseTool(tool, ctx.role)) continue;
        let parameters;
        try {
            parameters = resolveParameters(tool, ctx);
        } catch (error) {
            warnOnce(`parameters:${tool.name}`, `tool "${tool.name}" was left out of the manifest: its parameters could not be built (${error?.message || error})`);
            continue;
        }
        tools.push({ name: tool.name, description: tool.description, parameters, confirm: tool.confirm });
    }
    return { role: ctx.role, tools };
};
