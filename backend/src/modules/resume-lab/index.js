// Module "resume-lab" (docs/contracts/RESUME-BYOK.md §14): unified resumes,
// storage drivers, Tectonic compile, uploads + deterministic ATS scoring.
//
//   /api/v1/resumes      catalog (mountPath)
//   /api/v1/resume       legacy SIH upload + score
//   /api/v1/resume-bank  SIH Resume Bank compatibility
//
// Dependency direction: byok may import resume-lab services; resume-lab never imports byok.
import { registerJob } from "../../core/scheduler.js";
import { latexWarmupOnStart } from "./config.js";
import { hasTectonic, sweepLatexTmp, warmupLatex } from "./latex/compiler.js";
import bankRouter from "./routes/bank.routes.js";
import legacyRouter from "./routes/legacy.routes.js";
import resumesRouter from "./routes/resumes.routes.js";
import { migrateLegacyResumes } from "./services/migrate.service.js";
import tools from "./tools.js";

const TMP_SWEEP_INTERVAL_MS = 6 * 3600_000;

const start = async () => {
    try {
        await migrateLegacyResumes();
    } catch (error) {
        console.error("[resume-lab] legacy resume migration failed:", error);
    }
    try {
        await sweepLatexTmp();
    } catch (error) {
        console.warn("[resume-lab] temp directory sweep failed:", error?.message || error);
    }
    try {
        if (latexWarmupOnStart() && hasTectonic()) {
            // Background: caches the Tectonic bundle for offline demos; never blocks boot.
            warmupLatex().catch(() => {});
        }
    } catch (error) {
        console.warn("[resume-lab] LaTeX warm-up skipped:", error?.message || error);
    }
    try {
        registerJob("resume-lab:latex-tmp-sweep", TMP_SWEEP_INTERVAL_MS, () => sweepLatexTmp());
    } catch (error) {
        console.warn("[resume-lab] could not register the temp sweep job:", error?.message || error);
    }
};

export default {
    name: "resume-lab",
    mountPath: "/api/v1/resumes",
    router: resumesRouter,
    routers: [
        { path: "/api/v1/resume", router: legacyRouter },
        { path: "/api/v1/resume-bank", router: bankRouter },
    ],
    start,
    tools,
};

export { migrateLegacyResumes };
