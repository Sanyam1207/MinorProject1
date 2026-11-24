// System email (password resets, faculty/recruiter invites, notification
// emails) over SMTP via nodemailer. PR-outreach mail is different: it is sent
// from the user's own Gmail account by services/mail.service.js.
//
// When SMTP is not configured, sendMail() resolves with { skipped: true } so
// callers never fail because email is unavailable. Message bodies are never
// logged (they can contain reset links / temporary passwords).
import nodemailer from "nodemailer";
import {
    APP_NAME,
    SMTP_FROM,
    SMTP_HOST,
    SMTP_PASS,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_SERVICE,
    SMTP_USER,
} from "../config/config.js";

let transporter = null;

export const isMailerConfigured = () => Boolean((SMTP_SERVICE || SMTP_HOST) && SMTP_USER && SMTP_PASS);

const getTransporter = () => {
    if (!isMailerConfigured()) return null;
    if (!transporter) {
        const auth = { user: SMTP_USER, pass: SMTP_PASS };
        transporter = nodemailer.createTransport(
            SMTP_SERVICE
                ? { service: SMTP_SERVICE, auth }
                : { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth },
        );
    }
    return transporter;
};

const escapeHtml = (value = "") => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Minimal branded HTML wrapper for plain-text bodies. */
export const renderEmail = ({ title, body, actionUrl, actionLabel }) => {
    const paragraphs = String(body || "")
        .split(/\n{2,}/)
        .map((block) => `<p style="margin:0 0 12px">${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
        .join("");
    const action = actionUrl
        ? `<p style="margin:20px 0"><a href="${escapeHtml(actionUrl)}" style="background:#000;color:#fff;padding:10px 16px;text-decoration:none;font-weight:700">${escapeHtml(actionLabel || "Open")}</a></p>`
        : "";
    return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:auto;padding:24px">
<h2 style="margin:0 0 16px">${escapeHtml(title || APP_NAME)}</h2>${paragraphs}${action}
<p style="color:#666;font-size:12px;margin-top:24px">${escapeHtml(APP_NAME)}</p></body></html>`;
};

/**
 * Send an email. Never throws for "not configured"; throws only when a
 * configured SMTP server rejects the message.
 * @returns {Promise<{ skipped?: true, messageId?: string }>}
 */
export const sendMail = async ({ to, subject, text, html }) => {
    if (!to || !subject) throw new Error("sendMail requires `to` and `subject`");
    const transport = getTransporter();
    if (!transport) {
        if (process.env.NODE_ENV !== "test") {
            console.info(`[mailer] SMTP not configured; skipped "${subject}" to ${to}`);
        }
        return { skipped: true };
    }
    const info = await transport.sendMail({
        from: SMTP_FROM || SMTP_USER,
        to,
        subject,
        text: text || undefined,
        html: html || (text ? renderEmail({ title: subject, body: text }) : undefined),
    });
    return { messageId: info.messageId };
};
