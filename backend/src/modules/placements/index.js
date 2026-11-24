// Module "placements" (docs/contracts/PLACEMENTS.md): campus drives, applications, eligibility,
// offers + placement policy, training, recruiter drives, stats and announcements.
import { registerJob } from "../../core/scheduler.js";
import { placementsConfig } from "./config.js";
import applicationsRouter from "./routes/applications.routes.js";
import jobsRouter from "./routes/jobs.routes.js";
import offersRouter from "./routes/offers.routes.js";
import placementsRouter from "./routes/placements.routes.js";
import trainingRouter from "./routes/training.routes.js";
import { runPlacementMigrations } from "./services/migrate.js";
import { runSweep } from "./services/sweep.js";
import tools from "./tools.js";

export default {
    name: "placements",
    routers: [
        { path: "/api/v1/jobs", router: jobsRouter },
        { path: "/api/v1/drives", router: jobsRouter }, // alias: the same router instance
        { path: "/api/v1/applications", router: applicationsRouter },
        { path: "/api/v1/offers", router: offersRouter },
        { path: "/api/v1/training", router: trainingRouter },
        { path: "/api/v1/placements", router: placementsRouter },
    ],
    async start() {
        await runPlacementMigrations(); // idempotent; runs before server.listen
        registerJob("placements.sweep", placementsConfig.sweepIntervalMs, runSweep, { runOnStart: true });
    },
    tools,
};
