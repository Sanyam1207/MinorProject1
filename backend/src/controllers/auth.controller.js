// /api/v1/auth (docs/contracts/AUTH-FACULTY.md §4–§6).
//
// Never logs passwords, tokens, reset links or temporary passwords; failed
// logins log only a masked email. No JSON response ever contains the refresh
// token (it travels in the httpOnly cookie scoped to /api/v1/auth).
import crypto from "node:crypto";
import { APP_NAME } from "../config/config.js";
import { asyncHandler, fail, send } from "../core/http.js";
import { College } from "../models/college.models.js";
import { User, USER_AUTH_PROJECTION, USER_SAFE_PROJECTION } from "../models/user.models.js";
import { notify } from "../modules/notifications/notify.js";
import { accountMailer, sendPasswordChangedEmail, sendPasswordResetEmail } from "../services/account-mail.service.js";
import {
    afterLogin,
    aliasRole,
    assertLoginAllowed,
    claimCollegeTpoSlot,
    logAuthEvent,
    maskEmail,
    nameFromEmail,
    normalizeEmail,
    resolveRegistration,
} from "../services/auth-policy.service.js";
import {
    clearAuthCookies,
    currentSessionId,
    invalidateUserAccess,
    issueSession,
    presentedRefreshToken,
    refreshSession,
    revokeSession,
    setAuthCookies,
} from "../services/auth-session.service.js";
import { googleIdentity } from "../services/google-identity.service.js";
import { buildProfileUpdate, hasLockedIgnores, PROFILE_EMPTY_MESSAGE, PROFILE_LOCK_MESSAGE } from "../services/user-profile.service.js";
import { PASSWORD_MIN_LENGTH, validateNewPassword } from "../utils/password.js";
import { linkStudentToCollege } from "../utils/student-college.js";

const RESET_TOKEN_RE = /^[a-f0-9]{64}$/;
const FORGOT_PASSWORD_MESSAGE = "If an account exists for that email, a reset link has been sent.";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const userAgentOf = (req) => (typeof req.get === "function" ? req.get("user-agent") : undefined);

const requireEmail = (value) => {
    const email = normalizeEmail(value);
    if (!email) throw fail(400, "Enter a valid email address.", "VALIDATION", { field: "email" });
    return email;
};

const isExplicitRole = (value) => value !== undefined && value !== null && value !== "";

/** Create the account decided by resolveRegistration and apply the role-specific steps. */
const createRegisteredUser = async ({ fields, role, college }) => {
    const user = await User.create({
        ...fields,
        role,
        college: college?._id,
        collegeName: college?.name || undefined,
    });
    if (role === "tpo") {
        try {
            await claimCollegeTpoSlot(college, user._id);
        } catch (error) {
            await User.deleteOne({ _id: user._id });
            throw error;
        }
    } else if (role === "student" && college) {
        await linkStudentToCollege(user, college);
    }
    return user;
};

/** Issue a session, set the cookies and send the sign-in response. */
const completeSignIn = async (req, res, { user, isNewUser, roleAdjusted, via }) => {
    const session = await issueSession(user, { userAgent: userAgentOf(req) });
    setAuthCookies(res, session);
    logAuthEvent("auth", "login", { userId: String(user._id), role: user.role, via, isNewUser });
    const status = isNewUser ? 201 : 200;
    return send(
        res,
        { user, accessToken: session.accessToken, isNewUser, roleAdjusted },
        isNewUser ? "Account created and signed in" : "Signed in successfully",
        status,
    );
};

// ── Options ─────────────────────────────────────────────────────────────────

export const getAuthOptions = asyncHandler(async (_req, res) => {
    const colleges = await College.find({}).select("name domain").sort({ name: 1 }).limit(50).lean();
    let emailEnabled = false;
    let googleEnabled = false;
    try {
        emailEnabled = Boolean(accountMailer.isConfigured());
    } catch {
        emailEnabled = false;
    }
    try {
        googleEnabled = Boolean(googleIdentity.isConfigured());
    } catch {
        googleEnabled = false;
    }
    return send(res, {
        appName: APP_NAME,
        collegeDomains: colleges.map((college) => ({ domain: college.domain, name: college.name || college.domain })),
        google: { enabled: googleEnabled },
        passwordReset: { emailEnabled },
        passwordMinLength: PASSWORD_MIN_LENGTH,
    }, "Auth options");
});

// ── Password sign-in / registration ─────────────────────────────────────────

export const loginOrRegister = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = requireEmail(body.email);
    const { password } = body;
    if (typeof password !== "string" || !password) {
        throw fail(400, "Password is required.", "VALIDATION", { field: "password" });
    }
    const explicit = isExplicitRole(body.role);
    const requested = aliasRole(body.role) || "student";

    const existing = await User.findOne({ email }).select("+tokenVersion");
    if (existing) {
        if (!existing.password) {
            throw fail(
                400,
                "This account signs in with Google. Use Continue with Google, or Forgot password to set a password.",
                "PASSWORD_NOT_SET",
            );
        }
        if (!(await existing.isPasswordCorrect(password))) {
            logAuthEvent("auth", "login failed", { email: maskEmail(email) });
            throw fail(401, "Incorrect email or password.", "INVALID_CREDENTIALS");
        }
        assertLoginAllowed(existing, { via: "password" });
        await afterLogin(existing);
        return completeSignIn(req, res, {
            user: existing,
            isNewUser: false,
            roleAdjusted: explicit && requested !== existing.role,
            via: "password",
        });
    }

    const { role, college } = await resolveRegistration({ email, requestedRole: requested, password, via: "password" });
    if (role !== "tpo") validateNewPassword(password);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : nameFromEmail(email);
    const user = await createRegisteredUser({
        fields: { name, email, password, authProvider: "local" },
        role,
        college,
    });
    return completeSignIn(req, res, {
        user,
        isNewUser: true,
        roleAdjusted: explicit && requested !== role,
        via: "password",
    });
});

// ── Google sign-in (ID token only) ──────────────────────────────────────────

export const googleAuth = asyncHandler(async (req, res) => {
    let configured = false;
    try {
        configured = Boolean(googleIdentity.isConfigured());
    } catch {
        configured = false;
    }
    if (!configured) throw fail(503, "Google sign-in is not configured on this server.", "GOOGLE_NOT_CONFIGURED");

    const body = req.body || {};
    const idToken = body.credential ?? body.idToken;
    if (typeof idToken !== "string" || !idToken.trim() || idToken.length > 8192) {
        throw fail(400, "A Google credential is required.", "VALIDATION", { field: "credential" });
    }

    let payload;
    try {
        payload = await googleIdentity.verifyIdToken(idToken.trim());
    } catch {
        throw fail(401, "Google sign-in failed. Please try again.", "GOOGLE_TOKEN_INVALID");
    }
    const email = normalizeEmail(payload?.email);
    if (!payload || !email || typeof payload.sub !== "string" || !payload.sub) {
        throw fail(401, "Google sign-in failed. Please try again.", "GOOGLE_TOKEN_INVALID");
    }
    if (payload.email_verified !== true) {
        throw fail(403, "Your Google email address is not verified.", "EMAIL_NOT_VERIFIED");
    }

    const explicit = isExplicitRole(body.role);
    const requested = aliasRole(body.role) || "student";
    const picture = typeof payload.picture === "string" ? payload.picture.slice(0, 500) : undefined;

    const existing = await User.findOne({ email }).select("+tokenVersion");
    if (existing) {
        if (existing.googleId && existing.googleId !== payload.sub) {
            throw fail(403, "This account is linked to a different Google account.", "GOOGLE_ACCOUNT_MISMATCH");
        }
        assertLoginAllowed(existing, { via: "google" });
        let changed = false;
        if (!existing.googleId) {
            existing.googleId = payload.sub;
            changed = true;
        }
        if (!existing.profile && picture) {
            existing.profile = picture;
            changed = true;
        }
        if (changed) await existing.save({ validateBeforeSave: false });
        await afterLogin(existing);
        return completeSignIn(req, res, {
            user: existing,
            isNewUser: false,
            roleAdjusted: explicit && requested !== existing.role,
            via: "google",
        });
    }

    const { role, college } = await resolveRegistration({
        email,
        requestedRole: requested,
        via: "google",
        googlePayload: payload,
    });
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 80) : nameFromEmail(email);
    const user = await createRegisteredUser({
        fields: { name, email, authProvider: "google", googleId: payload.sub, profile: picture },
        role,
        college,
    });
    return completeSignIn(req, res, {
        user,
        isNewUser: true,
        roleAdjusted: explicit && requested !== role,
        via: "google",
    });
});

// ── Sessions ────────────────────────────────────────────────────────────────

export const refreshAccessToken = asyncHandler(async (req, res) => {
    const { accessToken } = await refreshSession(presentedRefreshToken(req));
    setAuthCookies(res, { accessToken });
    return send(res, { accessToken }, "Access token refreshed");
});

export const logoutUser = asyncHandler(async (req, res) => {
    const token = presentedRefreshToken(req);
    if (token) await revokeSession(token, "logout");
    clearAuthCookies(res);
    return send(res, {}, "Logged out successfully");
});

export const logoutAllSessions = asyncHandler(async (req, res) => {
    const { revoked } = await invalidateUserAccess(req.user._id, "logout_all");
    clearAuthCookies(res);
    logAuthEvent("auth", "logout-all", { userId: String(req.user._id), revoked });
    return send(res, { revoked }, "Signed out on every device");
});

// ── Password reset / change ─────────────────────────────────────────────────

/** Security alert (in-app notification + email). Best effort, never throws. */
const notifyPasswordChanged = async (user) => {
    try {
        await notify(user._id, {
            type: "security.password_changed",
            title: "Your password was changed",
            body: "If this wasn't you, contact your placement office immediately.",
            priority: "high",
        });
    } catch (error) {
        logAuthEvent("auth", "password-changed notification failed", { userId: String(user._id), error: error?.message || String(error) }, "warn");
    }
    await sendPasswordChangedEmail(user);
};

export const forgotPassword = asyncHandler(async (req, res) => {
    const email = requireEmail(req.body?.email);
    let configured = false;
    try {
        configured = Boolean(accountMailer.isConfigured());
    } catch {
        configured = false;
    }
    if (!configured) {
        throw fail(
            503,
            "Password reset by email is not available on this server. Ask your placement office (TPO) to reset your password.",
            "EMAIL_NOT_CONFIGURED",
        );
    }

    const user = await User.findOne({ email, isActive: { $ne: false } });
    if (user) {
        const rawToken = user.generatePasswordResetToken();
        await user.save({ validateBeforeSave: false });
        const result = await sendPasswordResetEmail(user, rawToken);
        if (!result.delivered) logAuthEvent("auth", "reset email failed", { userId: String(user._id) }, "warn");
    }
    return send(res, {}, FORGOT_PASSWORD_MESSAGE);
});

const findUserByResetToken = (token, extra = {}) => {
    if (typeof token !== "string" || !RESET_TOKEN_RE.test(token)) return null;
    return {
        passwordResetToken: sha256(token),
        passwordResetExpiry: { $gt: new Date() },
        isActive: { $ne: false },
        ...extra,
    };
};

const invalidResetToken = () => fail(400, "This reset link is invalid or has expired. Request a new one.", "RESET_TOKEN_INVALID");

export const checkResetToken = asyncHandler(async (req, res) => {
    const filter = findUserByResetToken(req.params.token);
    const user = filter ? await User.findOne(filter).select("email passwordResetExpiry").lean() : null;
    if (!user) throw invalidResetToken();
    return send(res, { valid: true, email: maskEmail(user.email), expiresAt: user.passwordResetExpiry }, "Reset link is valid");
});

export const resetPassword = asyncHandler(async (req, res) => {
    const filter = findUserByResetToken(req.params.token);
    if (!filter) throw invalidResetToken();
    const password = validateNewPassword(req.body?.password);

    // Claim the token atomically so it can be used exactly once.
    const user = await User.findOneAndUpdate(
        filter,
        { $unset: { passwordResetToken: 1, passwordResetExpiry: 1 } },
        { returnDocument: "after" },
    );
    if (!user) throw invalidResetToken();

    user.password = password;
    user.mustChangePassword = false;
    user.tempPasswordExpiresAt = undefined;
    await user.save({ validateBeforeSave: false });
    await invalidateUserAccess(user._id, "password_reset");
    logAuthEvent("auth", "password reset", { userId: String(user._id) });
    await notifyPasswordChanged(user);
    return send(res, {}, "Password reset. Sign in with your new password.");
});

export const changePassword = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const newPassword = validateNewPassword(body.newPassword, "newPassword");
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (currentPassword && currentPassword === newPassword) {
        throw fail(400, "Choose a password different from your current one.", "VALIDATION", { field: "newPassword" });
    }

    const user = await User.findById(req.user._id);
    if (!user) throw fail(401, "Unauthorized request", "UNAUTHORIZED");
    if (user.password) {
        if (!currentPassword || !(await user.isPasswordCorrect(currentPassword))) {
            throw fail(400, "Your current password is incorrect.", "INVALID_CURRENT_PASSWORD", { field: "currentPassword" });
        }
    }

    user.password = newPassword;
    user.mustChangePassword = false;
    user.tempPasswordExpiresAt = undefined;
    await user.save({ validateBeforeSave: false });

    const exceptSessionId = await currentSessionId(req);
    await invalidateUserAccess(user._id, "password_change", { exceptSessionId, kick: false });

    const fresh = await User.findById(user._id).select(USER_AUTH_PROJECTION);
    const accessToken = fresh.generateAccessToken();
    setAuthCookies(res, { accessToken });
    logAuthEvent("auth", "password changed", { userId: String(user._id) });
    await notifyPasswordChanged(fresh);
    return send(res, { accessToken, user: fresh }, "Password updated");
});

// ── Profile ─────────────────────────────────────────────────────────────────

export const getCurrentUser = asyncHandler(async (req, res) => send(res, req.user, "Current user fetched successfully"));

export const updateProfile = asyncHandler(async (req, res) => {
    const { set, unset, ignored } = buildProfileUpdate(req.user, req.body);
    const locked = hasLockedIgnores(ignored);
    const hasChanges = Object.keys(set).length > 0 || Object.keys(unset).length > 0;
    if (!hasChanges && !locked) throw fail(400, PROFILE_EMPTY_MESSAGE, "VALIDATION");

    let user = req.user;
    if (hasChanges) {
        const update = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        user = await User.findByIdAndUpdate(req.user._id, update, { returnDocument: "after", runValidators: true })
            .select(USER_SAFE_PROJECTION);
        if (!user) throw fail(404, "User not found", "NOT_FOUND");
    }
    return send(res, user, locked ? PROFILE_LOCK_MESSAGE : "Profile updated successfully");
});
