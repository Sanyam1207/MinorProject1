import axios from "axios";
import jwt from "jsonwebtoken";
import { User } from "../models/user.models.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { createOAuth2Client, GMAIL_SEND_SCOPES } from "../utils/google-oauth-client.js";
import { FRONTEND_URL, CLIENT_ID } from "../config/config.js";

const STATE_PURPOSE = "gmail-connect";

const getGmailAuthorizeUrl = asynchandler(async (req, res) => {
    const state = jwt.sign(
        { uid: req.user._id, purpose: STATE_PURPOSE },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "100m" },
    );

    const oauth2Client = createOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: GMAIL_SEND_SCOPES,
        state,
    });

    return res.status(200).json(new Apiresponse(200, { url }, "Gmail authorization URL generated"));
});

const gmailOAuthCallback = asynchandler(async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.redirect(`${FRONTEND_URL}/?gmail_error=denied`);
    }
    if (!code || !state) {
        return res.redirect(`${FRONTEND_URL}/?gmail_error=invalid_request`);
    }

    let decodedState;
    try {
        decodedState = jwt.verify(state, process.env.ACCESS_TOKEN_SECRET);
    } catch (err) {
        return res.redirect(`${FRONTEND_URL}/?gmail_error=invalid_state`);
    }
    if (decodedState.purpose !== STATE_PURPOSE || !decodedState.uid) {
        return res.redirect(`${FRONTEND_URL}/?gmail_error=invalid_state`);
    }

    const oauth2Client = createOAuth2Client();

    let tokens;
    try {
        ({ tokens } = await oauth2Client.getToken(code));
    } catch (err) {
        console.error("Gmail OAuth token exchange failed:", err.message);
        return res.redirect(`${FRONTEND_URL}/?gmail_error=token_exchange_failed`);
    }

    if (!tokens.refresh_token) {
        return res.redirect(`${FRONTEND_URL}/?gmail_error=no_refresh_token`);
    }

    let connectedEmail;
    try {
        const ticket = await oauth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: CLIENT_ID,
        });
        connectedEmail = ticket.getPayload().email;
    } catch (err) {
        console.error("Gmail OAuth id_token verification failed:", err.message);
        return res.redirect(`${FRONTEND_URL}/?gmail_error=identity_verification_failed`);
    }

    await User.findByIdAndUpdate(decodedState.uid, {
        $set: {
            gmailConnection: {
                connectedEmail,
                connectedAt: new Date(),
                scope: tokens.scope || GMAIL_SEND_SCOPES.join(" "),
            },
            gmailRefreshTokenEncrypted: encrypt(tokens.refresh_token),
        },
    });

    return res.redirect(`${FRONTEND_URL}/?gmail_connected=1`);
});

const disconnectGmail = asynchandler(async (req, res) => {
    const user = await User.findById(req.user._id).select("+gmailRefreshTokenEncrypted");
    if (user?.gmailRefreshTokenEncrypted) {
        try {
            const refreshToken = decrypt(user.gmailRefreshTokenEncrypted);
            await axios.post(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`);
        } catch (err) {
            console.warn("Gmail token revoke call failed (continuing with local disconnect):", err.message);
        }
    }

    await User.findByIdAndUpdate(req.user._id, {
        $unset: { gmailConnection: 1, gmailRefreshTokenEncrypted: 1 },
    });

    return res.status(200).json(new Apiresponse(200, {}, "Gmail disconnected"));
});

export { getGmailAuthorizeUrl, gmailOAuthCallback, disconnectGmail };
