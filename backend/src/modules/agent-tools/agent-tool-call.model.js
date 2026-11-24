// Audit trail of every copilot tool execution (AGENT-TOOLS.md §3), kept for 30 days.
import mongoose, { Schema } from "mongoose";

export const AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60;

const agentToolCallSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // The caller's college at the time of the call; TPOs only see their own college.
    college: { type: Schema.Types.ObjectId, ref: "College", default: null },
    role: { type: String, default: null },
    tool: { type: String, required: true },
    module: { type: String, default: null },
    // Normalised arguments when validation passed, else what was sent; long
    // strings are truncated and secret-looking keys redacted (audit.js).
    args: { type: Schema.Types.Mixed, default: () => ({}) },
    ok: { type: Boolean, required: true },
    // Error code for failures ("NEEDS_CONFIRMATION" for a preview), null on success.
    error: { type: String, default: null },
    // Failure message or confirmation preview (truncated), null on success.
    message: { type: String, default: null },
    durationMs: { type: Number, default: 0 },
    requestId: { type: String, default: null },
    sessionId: { type: String, default: null },
    confirmed: { type: Boolean, default: false },
}, {
    collection: "agent_tool_calls",
    timestamps: { createdAt: true, updatedAt: false },
    minimize: false,
});

agentToolCallSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_TTL_SECONDS });
agentToolCallSchema.index({ user: 1, createdAt: -1 });
agentToolCallSchema.index({ tool: 1, createdAt: -1 });
agentToolCallSchema.index({ college: 1, createdAt: -1 });

export const AgentToolCall = mongoose.models.AgentToolCall || mongoose.model("AgentToolCall", agentToolCallSchema);
