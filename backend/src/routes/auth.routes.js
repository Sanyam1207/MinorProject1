// /api/v1/auth route table and rate limits (docs/contracts/AUTH-FACULTY.md §5, §12).
import { Router } from "express";
import {
    changePassword,
    checkResetToken,
    forgotPassword,
    getAuthOptions,
    getCurrentUser,
    googleAuth,
    loginOrRegister,
    logoutAllSessions,
    logoutUser,
    refreshAccessToken,
    resetPassword,
    updateProfile,
} from "../controllers/auth.controller.js";
import {
    getGmailAuthorizeUrl,
    gmailOAuthCallback,
    disconnectGmail,
} from "../controllers/google-gmail.controller.js";
import { rateLimit } from "../core/rate-limit.js";
import { optionalAuth, verifyJWT } from "../middlewares/auth.middleware.js";
import { normalizeEmail } from "../services/auth-policy.service.js";

const router = Router();

const MINUTE = 60_000;
const bodyEmail = (req) => normalizeEmail(req.body?.email) || "-";

// Per-IP limits are generous on purpose: a whole classroom can share one NAT IP.
const authIp = rateLimit({ windowMs: 15 * MINUTE, max: 300 });
const loginEmail = rateLimit({
    windowMs: 15 * MINUTE,
    max: 10,
    keyFn: bodyEmail,
    message: "Too many sign-in attempts for this account. Try again in 15 minutes.",
});
const refresh = rateLimit({ windowMs: 15 * MINUTE, max: 600 });
const forgotIp = rateLimit({ windowMs: 60 * MINUTE, max: 30 });
const forgotEmail = rateLimit({
    windowMs: 60 * MINUTE,
    max: 3,
    keyFn: bodyEmail,
    message: "Too many reset requests for this email. Try again later.",
});
const reset = rateLimit({ windowMs: 15 * MINUTE, max: 20 });
const changePasswordLimit = rateLimit({
    windowMs: 15 * MINUTE,
    max: 10,
    keyFn: (req) => String(req.user?._id || "-"),
});

router.get("/options", getAuthOptions);

router.post("/login-or-register", authIp, loginEmail, loginOrRegister);
router.post("/login", authIp, loginEmail, loginOrRegister);
router.post("/register", authIp, loginEmail, loginOrRegister);
router.post("/google", authIp, googleAuth);

router.post("/refresh-token", refresh, refreshAccessToken);
router.post("/logout", optionalAuth, logoutUser);
router.post("/logout-all", verifyJWT, logoutAllSessions);

router.post("/forgot-password", forgotIp, forgotEmail, forgotPassword);
router.get("/reset-password/:token", reset, checkResetToken);
router.post("/reset-password/:token", reset, resetPassword);
router.post("/change-password", verifyJWT, changePasswordLimit, changePassword);

router.route("/me").get(verifyJWT, getCurrentUser).patch(verifyJWT, updateProfile);

// Per-user Gmail OAuth (PR & Outreach sending) — unchanged.
router.route("/google/gmail/authorize-url").get(verifyJWT, getGmailAuthorizeUrl);
router.route("/google/gmail/callback").get(gmailOAuthCallback);
router.route("/google/gmail/disconnect").post(verifyJWT, disconnectGmail);

export default router;
