// Feature-module registry.
//
// Every feature added by the integration lives in src/modules/<name>/ and
// exports a default object:
//   {
//     name: "attendance",
//     mountPath?: "/api/v1/attendance", router?: express.Router,
//     routers?: [{ path: "/api/v1/drives", router }],      // extra mounts
//     registerSocket?(io, socket, { user }),                 // per authenticated connection
//     start?({ io }),                                        // once, after MongoDB connects
//     tools?: AgentTool[],                                   // see docs/contracts/AGENT-TOOLS.md
//   }
// The app, socket server and agent-tools registry discover modules only
// through this file, so modules never import each other's wiring.
import notifications from "./notifications/index.js";
import attendance from "./attendance/index.js";
import placements from "./placements/index.js";
import jobFeed from "./job-feed/index.js";
import resumeLab from "./resume-lab/index.js";
import byok from "./byok/index.js";
import faculty from "./faculty/index.js";
import issueReports from "./issue-reports/index.js";
import agentTools from "./agent-tools/index.js";

export const modules = [
    notifications,
    attendance,
    placements,
    jobFeed,
    resumeLab,
    byok,
    faculty,
    issueReports,
    agentTools,
];

export const mountModuleRouters = (app) => {
    for (const mod of modules) {
        if (mod.router && mod.mountPath) app.use(mod.mountPath, mod.router);
        for (const { path, router } of mod.routers || []) {
            if (path && router) app.use(path, router);
        }
    }
};

export const registerModuleSockets = (io, socket, context) => {
    for (const mod of modules) {
        if (typeof mod.registerSocket !== "function") continue;
        try {
            mod.registerSocket(io, socket, context);
        } catch (error) {
            console.error(`[modules] ${mod.name}.registerSocket failed:`, error);
        }
    }
};

export const startModules = async (context) => {
    for (const mod of modules) {
        if (typeof mod.start !== "function") continue;
        try {
            await mod.start(context);
        } catch (error) {
            console.error(`[modules] ${mod.name}.start failed:`, error);
        }
    }
};

/** All agent tools exported by modules, tagged with their module name. */
export const collectAgentTools = () =>
    modules.flatMap((mod) => (Array.isArray(mod.tools) ? mod.tools : []).map((tool) => ({ ...tool, module: mod.name })));
