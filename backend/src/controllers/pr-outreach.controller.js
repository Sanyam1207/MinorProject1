import { sendOutreachEmailAsUser } from "../services/mail.service.js";
import { User } from "../models/user.models.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
import {
    claimPROutreachSend,
    completePROutreachSend,
    releasePROutreachSend,
} from "../utils/pr-outreach-session.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sendEmail = asynchandler(async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    const to = String(req.body?.to || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const body = String(req.body?.body || "").trim();

    if (!sessionId) throw new ApiError(400, "PR outreach session ID is required");
    if (!EMAIL_PATTERN.test(to)) throw new ApiError(400, "A valid recipient email is required");
    if (!subject || subject.length > 300 || /[\r\n]/.test(subject)) {
        throw new ApiError(400, "Email subject is required, must be under 300 characters, and cannot contain line breaks");
    }
    if (!body || body.length > 50000) throw new ApiError(400, "Email body is required and must be under 50,000 characters");

    if (!req.user.gmailConnection?.connectedEmail) {
        throw new ApiError(428, "Connect your Gmail account before sending outreach email", ["GMAIL_NOT_CONNECTED"]);
    }

    const claim = claimPROutreachSend({ sessionId, userId: req.user._id });
    if (!claim.ok) {
        if (claim.reason === "forbidden") throw new ApiError(403, "This outreach session belongs to another user");
        if (claim.reason === "confidence") throw new ApiError(403, "Agent confidence must be greater than 85% before sending");
        if (claim.reason === "sending") throw new ApiError(409, "This email is already being sent");
        if (claim.reason === "sent") throw new ApiError(409, "This outreach email has already been sent");
        throw new ApiError(409, "Ask the outreach agent to review this draft before sending");
    }

    try {
        const sender = await User.findById(req.user._id).select("+gmailRefreshTokenEncrypted");
        const result = await sendOutreachEmailAsUser(sender, { to, subject, body });
        completePROutreachSend({ sessionId, messageId: result.messageId });

        return res.status(200).json(new Apiresponse(200, {
            status: "sent",
            messageId: result.messageId,
            accepted: result.accepted || [],
            rejected: result.rejected || [],
        }, "Mail sent successfully"));
    } catch (error) {
        releasePROutreachSend(sessionId);
        if (error instanceof ApiError) {
            if (error.errors?.includes("GMAIL_RECONNECT_REQUIRED")) {
                await User.findByIdAndUpdate(req.user._id, {
                    $unset: { gmailConnection: 1, gmailRefreshTokenEncrypted: 1 },
                });
            }
            throw error;
        }
        throw new ApiError(502, `Unable to send mail: ${error.message}`);
    }
});

export { sendEmail };
