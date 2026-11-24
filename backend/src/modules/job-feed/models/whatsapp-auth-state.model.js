// WhatsAppAuthState — the WhatsApp linked-device login (docs/contracts/JOB-FEED.md §2.4).
// `_id` is the Baileys key name ("creds", "<type>-<id>"); `value` is the
// AES-256-GCM encrypted JSON (src/utils/crypto.js, TOKEN_ENCRYPTION_KEY).
// Anyone who can decrypt it can read the linked WhatsApp account: it is never
// returned by an API and never logged.
import mongoose from "mongoose";

const whatsAppAuthStateSchema = new mongoose.Schema(
    {
        _id: String,
        value: { type: String, required: true },
    },
    { timestamps: true, collection: "whatsapp_auth_state" },
);

export const WhatsAppAuthState = mongoose.models.WhatsAppAuthState
    || mongoose.model("WhatsAppAuthState", whatsAppAuthStateSchema);
export default WhatsAppAuthState;
