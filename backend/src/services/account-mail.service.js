// Account email: password reset, faculty/recruiter invites, password-changed
// alerts (docs/contracts/AUTH-FACULTY.md §7.4).
//
// `accountMailer` is a mutable test seam over core/mailer.js. Every helper
// resolves to {delivered: boolean, error?: string}, never throws and never
// logs message bodies (they contain reset links or temporary passwords).
import { DateTime } from "luxon";
import { APP_NAME, APP_TIMEZONE, FRONTEND_URL, PASSWORD_RESET_TTL_MINUTES } from "../config/config.js";
import { isMailerConfigured, renderEmail, sendMail } from "../core/mailer.js";

export const accountMailer = {
    isConfigured: () => isMailerConfigured(),
    send: (message) => sendMail(message),
};

export const resetPasswordUrl = (rawToken) => `${FRONTEND_URL}/reset-password/${rawToken}`;

/** "25 Nov 2026, 14:30 IST" in the college time zone. */
export const formatAccountDate = (date) => {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return "";
    return DateTime.fromJSDate(value).setZone(APP_TIMEZONE).toFormat("d LLL yyyy, HH:mm ZZZZ");
};

const deliver = async ({ to, subject, text, actionUrl, actionLabel }, logLabel) => {
    if (!to) return { delivered: false, error: "No recipient address" };
    let configured = false;
    try {
        configured = Boolean(accountMailer.isConfigured());
    } catch {
        configured = false;
    }
    if (!configured) return { delivered: false, error: "Email is not configured on this server" };
    try {
        const result = await accountMailer.send({
            to,
            subject,
            text: actionUrl ? `${text}\n\n${actionLabel || "Open"}: ${actionUrl}` : text,
            html: renderEmail({ title: subject, body: text, actionUrl, actionLabel }),
        });
        if (result?.skipped) return { delivered: false, error: "Email is not configured on this server" };
        return { delivered: true };
    } catch (error) {
        // Never log the message (it may hold a reset link or a temporary password).
        if (process.env.NODE_ENV !== "test" || process.env.AUTH_TEST_LOGS === "true") {
            console.warn(`[auth] ${logLabel} email failed: ${error?.code || error?.name || "send error"}`);
        }
        return { delivered: false, error: "Could not send the email" };
    }
};

export const sendPasswordResetEmail = (user, rawToken) => deliver({
    to: user?.email,
    subject: `Reset your ${APP_NAME} password`,
    text: `We received a request to reset the password for ${user?.email}. `
        + `The link expires in ${PASSWORD_RESET_TTL_MINUTES} minutes. If you did not ask for this, ignore this email.`,
    actionUrl: resetPasswordUrl(rawToken),
    actionLabel: "Reset password",
}, "reset");

/** `kind` is "faculty" or "recruiter". */
export const sendInviteEmail = ({ user, temporaryPassword, inviter, college, kind = "faculty" }) => {
    const expires = user?.tempPasswordExpiresAt ? formatAccountDate(user.tempPasswordExpiresAt) : "";
    const inviterName = inviter?.name || "Your placement office";
    const collegeName = college?.name || college?.domain || "your college";
    return deliver({
        to: user?.email,
        subject: `You're invited to ${APP_NAME}`,
        text: `Hello ${user?.name || ""},\n\n`
            + `${inviterName} (${collegeName}) created a ${kind === "recruiter" ? "recruiter" : "faculty"} account for you.\n\n`
            + `Email: ${user?.email}\nTemporary password: ${temporaryPassword}\n\n`
            + "You will choose a new password after signing in."
            + (expires ? ` The temporary password expires on ${expires}.` : ""),
        actionUrl: `${FRONTEND_URL}/`,
        actionLabel: "Sign in",
    }, "invite");
};

export const sendPasswordChangedEmail = (user, when = new Date()) => deliver({
    to: user?.email,
    subject: `Your ${APP_NAME} password was changed`,
    text: `Your password was changed on ${formatAccountDate(when)}. `
        + "If this wasn't you, contact your placement office immediately.",
}, "password-changed");
