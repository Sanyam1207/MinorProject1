// Runs the job-feed WhatsApp listener on its own (docs/contracts/JOB-FEED.md §11.5):
//   cd backend && node scripts/job-feed-whatsapp.js      (npm run whatsapp)
// To run it inside the API instead, set WHATSAPP_ENABLED=true. Run only ONE
// listener per WhatsApp login (in-API or standalone, never both).
// See docs/JOB-FEED-OPERATIONS.md for linking a device and the settings.
import mongoose from "mongoose";
import DBConnect from "../src/db/db.js";
import { startWhatsAppListener } from "../src/modules/job-feed/whatsapp/listener.service.js";

let listener = null;
let stopping = false;

async function shutdown(exitCode, message) {
    if (stopping) return;
    stopping = true;
    if (message) console.error(`WhatsApp: ${message}`);
    try {
        await listener?.stop();
    } catch (error) {
        console.error("WhatsApp: the listener did not stop cleanly:", error?.message || error);
    }
    await mongoose.disconnect().catch(() => {});
    process.exit(exitCode);
}

async function main() {
    await DBConnect();
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    listener = await startWhatsAppListener({ onFatal: (message) => shutdown(1, message) });
    if (!listener.available) await shutdown(1, "the listener is unavailable (see the message above).");
}

main().catch(async (error) => {
    console.error("WhatsApp listener failed to start:", error?.message || error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
