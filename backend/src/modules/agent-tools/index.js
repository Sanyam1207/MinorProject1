// Module "agent-tools": the security boundary between the Python copilot and
// the backend (docs/contracts/AGENT-TOOLS.md §1–§4).
//   - /api/v1/agent-tools/manifest + /execute, authenticated by the copilot tool token only
//   - /api/v1/agent-tools/audit for tpo/admin (normal access token)
//   - the common tools open_panel and get_my_profile
// Other modules' tools are collected lazily from modules/index.js at request time.
import router from "./routes.js";
import commonTools from "./common.tools.js";

export { buildManifest, buildToolContext, executeTool } from "./executor.js";
export { registerExtraTools, resetExtraTools } from "./registry.js";

export default {
    name: "agent-tools",
    mountPath: "/api/v1/agent-tools",
    router,
    tools: commonTools,
};
