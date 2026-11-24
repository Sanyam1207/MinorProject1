import { Router } from "express";
import {
    loginOrRegister,
    logoutUser,
    refreshAccessToken,
    forgotPassword,
    resetPassword,
    getCurrentUser,
    updateProfile,
} from "../controllers/auth.controller.js";
import {
    getGmailAuthorizeUrl,
    gmailOAuthCallback,
    disconnectGmail,
} from "../controllers/google-gmail.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/login-or-register").post(loginOrRegister);
router.route("/login").post(loginOrRegister);
router.route("/register").post(loginOrRegister);
router.route("/refresh-token").post(refreshAccessToken);
router.route("/forgot-password").post(forgotPassword);
router.route("/reset-password/:token").post(resetPassword);

// Authenticated user profile routes
router.route("/me").get(verifyJWT, getCurrentUser).patch(verifyJWT, updateProfile);
router.route("/logout").post(verifyJWT, logoutUser);

// Per-user Gmail OAuth (PR & Outreach sending)
router.route("/google/gmail/authorize-url").get(verifyJWT, getGmailAuthorizeUrl);
router.route("/google/gmail/callback").get(gmailOAuthCallback);
router.route("/google/gmail/disconnect").post(verifyJWT, disconnectGmail);

export default router;
