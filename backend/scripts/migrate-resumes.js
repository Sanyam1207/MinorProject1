// Migrate legacy SIH Resume Bank documents to the unified Resume model
// (docs/contracts/RESUME-BYOK.md §2.4). Idempotent; the same function runs at boot.
//
//   npm run migrate:resumes      (uses MONGO_URI / DB_NAME from backend/.env)
import mongoose from "mongoose";
import connectDB from "../src/db/db.js";
import { migrateLegacyResumes } from "../src/modules/resume-lab/services/migrate.service.js";

try {
    await connectDB();
    const counts = await migrateLegacyResumes({ log: false });
    console.log(`[migrate-resumes] ${JSON.stringify(counts)}`);
    process.exitCode = 0;
} catch (error) {
    console.error("[migrate-resumes] failed:", error);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect().catch(() => {});
}
