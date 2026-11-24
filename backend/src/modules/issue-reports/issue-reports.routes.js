// /api/v1/issue-reports (docs/contracts/AUTH-FACULTY.md §9, §12).
//   POST  /     anyone (optionalAuth); rate limited per IP and per email
//   GET   /     tpo (own college + anonymous) / admin (all)
//   PATCH /:id  tpo / admin triage
import { Router } from "express";
import { asyncHandler, requireAuth, requireRole, send } from "../../core/http.js";
import { rateLimit } from "../../core/rate-limit.js";
import { optionalAuth } from "../../middlewares/auth.middleware.js";
import { normalizeEmail } from "../../services/auth-policy.service.js";
import {
    createIssueReport,
    ISSUE_THANKS_MESSAGE,
    listIssueReports,
    updateIssueReport,
} from "./issue-reports.service.js";

const router = Router();
const MINUTE = 60_000;

const issueIp = rateLimit({ windowMs: 10 * MINUTE, max: 10 });
const issueEmail = rateLimit({
    windowMs: 60 * MINUTE,
    max: 5,
    keyFn: (req) => req.user?.email || normalizeEmail(req.body?.email) || "-",
});

router.post("/", optionalAuth, issueIp, issueEmail, asyncHandler(async (req, res) => {
    const { id } = await createIssueReport({ user: req.user, body: req.body, userAgent: req.get("user-agent") });
    return send(res, { id }, ISSUE_THANKS_MESSAGE, 201);
}));

router.get("/", requireAuth, requireRole("tpo"), asyncHandler(async (req, res) => {
    return send(res, await listIssueReports({ actor: req.user, query: req.query || {} }));
}));

router.patch("/:id", requireAuth, requireRole("tpo"), asyncHandler(async (req, res) => {
    const report = await updateIssueReport({ actor: req.user, id: req.params.id, body: req.body });
    return send(res, { report }, "Issue report updated");
}));

export default router;
