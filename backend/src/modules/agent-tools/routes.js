// /api/v1/agent-tools (docs/contracts/AGENT-TOOLS.md §3)
//   GET  /manifest  tool token → {role, tools:[{name, description, parameters, confirm}]}
//   POST /execute   tool token, {tool, args, confirmed?} → tool result (always HTTP 200)
//   GET  /audit     normal access token, tpo/admin → {items, total, page, limit, hasNextPage}
import { Router } from "express";
import { asyncHandler, requireAuth, requireRole, send } from "../../core/http.js";
import { rateLimit } from "../../core/rate-limit.js";
import { listAuditEntries } from "./audit.js";
import { requireToolToken } from "./auth.js";
import { buildManifest, executeTool } from "./executor.js";

const router = Router();

// Guards against a runaway agent loop; far above what a person chatting needs
// (the copilot makes at most 6 tool calls per message).
const executeLimiter = rateLimit({
    windowMs: 60_000,
    max: 240,
    keyFn: (req) => String(req.user?._id ?? ""),
    message: "Too many tool calls in a short time. Please wait a moment and try again.",
});

router.get("/manifest", requireToolToken, asyncHandler(async (req, res) => {
    send(res, await buildManifest(req.toolContext), "Agent tool manifest");
}));

router.post("/execute", requireToolToken, executeLimiter, asyncHandler(async (req, res) => {
    const result = await executeTool(req.toolContext, req.body);
    send(res, result, result.ok ? "Tool executed" : "Tool did not run");
}));

router.get("/audit", requireAuth, requireRole("tpo", "admin"), asyncHandler(async (req, res) => {
    send(res, await listAuditEntries(req.user, req.query), "Agent tool audit trail");
}));

export default router;
