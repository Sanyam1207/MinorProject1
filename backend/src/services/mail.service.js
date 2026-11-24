import axios from "axios";
import { ApiError } from "../utils/api-error.js";
import { decrypt } from "../utils/crypto.js";
import { createOAuth2Client } from "../utils/google-oauth-client.js";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const base64UrlEncode = (buffer) =>
    buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

const encodeHeaderValue = (value) => `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const buildRawMessage = ({ from, to, subject, body }) => {
    const message = [
        `From: ${from}`,
        `To: ${to}`,
        `Reply-To: ${from}`,
        `Subject: ${encodeHeaderValue(subject)}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        body,
    ].join("\r\n");

    return base64UrlEncode(Buffer.from(message, "utf8"));
};

export const sendOutreachEmailAsUser = async (user, { to, subject, body }) => {
    const connectedEmail = user?.gmailConnection?.connectedEmail;
    if (!connectedEmail || !user?.gmailRefreshTokenEncrypted) {
        throw new ApiError(428, "Connect your Gmail account before sending outreach email", ["GMAIL_NOT_CONNECTED"]);
    }

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: decrypt(user.gmailRefreshTokenEncrypted) });

    let accessToken;
    try {
        ({ token: accessToken } = await oauth2Client.getAccessToken());
    } catch (error) {
        console.error("Gmail token refresh failed:", error.response?.data || error.message);
        if (error.message?.includes("invalid_grant")) {
            throw new ApiError(428, "Your Gmail authorization has expired. Please reconnect Gmail.", ["GMAIL_RECONNECT_REQUIRED"]);
        }
        throw new ApiError(502, `Unable to refresh Gmail access token: ${error.message}`);
    }

    const raw = buildRawMessage({ from: connectedEmail, to, subject, body });

    try {
        const { data } = await axios.post(
            GMAIL_SEND_URL,
            { raw },
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        return { messageId: data.id, accepted: [to], rejected: [] };
    } catch (error) {
        console.error("Gmail send failed:", JSON.stringify(error.response?.data || error.message));
        const reason = error.response?.data?.error?.status;
        if (reason === "PERMISSION_DENIED" || reason === "UNAUTHENTICATED") {
            throw new ApiError(428, "Your Gmail authorization has expired. Please reconnect Gmail.", ["GMAIL_RECONNECT_REQUIRED"]);
        }
        throw new ApiError(502, `Unable to send mail: ${error.response?.data?.error?.message || error.message}`);
    }
};
