// The copilot's tool registry: every tool exported by a feature module
// (`tools` on the module object, gathered by modules/index.js →
// collectAgentTools()) plus tools registered by tests.
//
// Tool definition (docs/contracts/AGENT-TOOLS.md §2):
//   {
//     name: "attendance_schedule_class",  // ^[a-z][a-z0-9_]{2,63}$, unique across modules
//     description: "…",                    // written for the LLM
//     roles: ["teacher"],                  // who may see/execute it; "*" or "all" = every role
//     confirm: true,                       // side effects → explicit user approval first
//     parameters: { type: "object", properties: {…}, required: [...] }
//                 | (ctx) => schema,       // per-caller schema (e.g. open_panel's panel enum)
//     preview?: async (args, ctx) => ({ summary, args }),   // confirm tools; no side effects
//     handler: async (args, ctx) => ({ summary, data?, ui? }) | { ambiguous: true, message, candidates },
//   }
//
// Role rule: a tool is available to the roles it lists. `admin` is a superuser
// over the placement office: it also gets every tool that lists `tpo`
// (UI-ACTIONS.md: "admin always has exactly the tpo rights"), but not tools
// meant only for students, teachers, companies or alumni.
import { ALL_ROLES, TOOL_NAME_RE } from "./constants.js";
import commonTools from "./common.tools.js";
import { resetWarnings, warnOnce } from "./log.js";
import { isPlainObject } from "./validate.js";

const KNOWN_ROLES = new Set(ALL_ROLES);
const WILDCARDS = new Set(["*", "all"]);

let extraTools = [];
let collectorPromise = null;

// modules/index.js imports this module (through agent-tools/index.js), so it is
// loaded lazily, at request time, once every module has been evaluated. A
// static import used at the top level would hit the circular import.
const loadCollector = () => {
    collectorPromise ||= import("../index.js")
        .then((registry) => (typeof registry.collectAgentTools === "function" ? registry.collectAgentTools : null))
        .catch((error) => {
            console.error("[agent-tools] could not load the module registry; only the common tools are available:", error);
            return null;
        });
    return collectorPromise;
};

const moduleToolDefinitions = async () => {
    const collect = await loadCollector();
    if (collect) {
        try {
            const tools = collect();
            if (Array.isArray(tools)) return tools;
        } catch (error) {
            warnOnce("collect-failed", `collectAgentTools() failed; only the common tools are available: ${error?.message || error}`);
        }
    }
    return commonTools.map((tool) => ({ ...tool, module: "agent-tools" }));
};

const normaliseRoles = (declared, toolName) => {
    const list = Array.isArray(declared) ? declared : declared == null ? [] : [declared];
    const roles = new Set();
    for (const entry of list) {
        const role = typeof entry === "string" ? entry.trim().toLowerCase() : "";
        if (WILDCARDS.has(role)) roles.add("*");
        else if (KNOWN_ROLES.has(role)) roles.add(role);
        else warnOnce(`unknown-role:${toolName}:${String(entry)}`, `tool "${toolName}" lists an unknown role ${JSON.stringify(entry ?? null)}; it is ignored`);
    }
    return roles;
};

const normaliseTool = (definition) => {
    if (!definition || typeof definition !== "object") return null;
    const module = typeof definition.module === "string" && definition.module ? definition.module : "unknown";
    const name = typeof definition.name === "string" ? definition.name.trim() : "";
    if (!TOOL_NAME_RE.test(name)) {
        warnOnce(
            `invalid-name:${module}:${String(definition.name)}`,
            `ignoring a tool from module "${module}" with the invalid name ${JSON.stringify(definition.name ?? null)} (names must match ${TOOL_NAME_RE})`,
        );
        return null;
    }
    if (typeof definition.handler !== "function") {
        warnOnce(`no-handler:${module}:${name}`, `ignoring tool "${name}" from module "${module}": it has no handler function`);
        return null;
    }
    const roles = normaliseRoles(definition.roles, name);
    if (roles.size === 0) {
        warnOnce(`no-roles:${module}:${name}`, `ignoring tool "${name}" from module "${module}": it declares no valid roles`);
        return null;
    }
    return Object.freeze({
        name,
        module,
        description: typeof definition.description === "string" ? definition.description.trim() : "",
        roles,
        confirm: Boolean(definition.confirm),
        parameters: definition.parameters ?? null,
        preview: typeof definition.preview === "function" ? definition.preview : null,
        handler: definition.handler,
    });
};

/**
 * All usable tools by name, in module order (then test extras). Invalid
 * definitions are skipped; for a duplicate name the first definition wins.
 * Each problem is logged once per process.
 * @returns {Promise<Map<string, object>>}
 */
export const getToolRegistry = async () => {
    const definitions = [...(await moduleToolDefinitions()), ...extraTools];
    const tools = new Map();
    for (const definition of definitions) {
        const tool = normaliseTool(definition);
        if (!tool) continue;
        const existing = tools.get(tool.name);
        if (existing) {
            warnOnce(
                `duplicate:${tool.name}`,
                `duplicate tool name "${tool.name}" from module "${tool.module}" ignored; keeping the one from module "${existing.module}"`,
            );
            continue;
        }
        tools.set(tool.name, tool);
    }
    return tools;
};

/** Whether `role` may see and execute `tool` (see the role rule above). */
export const canUseTool = (tool, role) => Boolean(tool && role) && (
    tool.roles.has("*")
    || tool.roles.has(role)
    || (role === "admin" && tool.roles.has("tpo"))
);

/**
 * The tool's parameter schema for this caller, always an object schema with
 * `type: "object"` and a `properties` map. May throw if a schema function throws.
 */
export const resolveParameters = (tool, ctx) => {
    const declared = typeof tool.parameters === "function" ? tool.parameters(ctx) : tool.parameters;
    const schema = isPlainObject(declared) ? declared : {};
    return {
        ...schema,
        type: "object",
        properties: isPlainObject(schema.properties) ? schema.properties : {},
    };
};

/**
 * TEST HOOK: register extra tool definitions (appended after the module
 * tools, so a duplicate name never shadows a real tool).
 * @returns {() => void} removes exactly these tools again
 */
export const registerExtraTools = (tools, moduleName = "test") => {
    const added = (Array.isArray(tools) ? tools : [tools])
        .filter((tool) => tool && typeof tool === "object")
        .map((tool) => ({ ...tool, module: tool.module || moduleName }));
    extraTools = [...extraTools, ...added];
    return () => {
        extraTools = extraTools.filter((tool) => !added.includes(tool));
    };
};

/** TEST HOOK: drop every extra tool and forget the warnings already printed. */
export const resetExtraTools = () => {
    extraTools = [];
    resetWarnings();
};
