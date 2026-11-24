// Shared constants of the agent-tools registry (docs/contracts/AGENT-TOOLS.md).

/** Every role a User can have (models/user.models.js). */
export const ALL_ROLES = Object.freeze(["student", "teacher", "tpo", "admin", "company", "alumni"]);

/** Tool names: lower snake case, 3–64 characters, unique across modules (AGENT-TOOLS.md §2). */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** `typ` claim of the short-lived copilot tool token (AGENT-TOOLS.md §1). */
export const TOOL_TOKEN_TYPE = "agent-tool";

/** Human wording for each role (matches the copilot prompt, PYTHON.md §5.6). */
export const ROLE_LABELS = Object.freeze({
    student: "student",
    teacher: "teacher",
    tpo: "training & placement officer",
    admin: "administrator",
    company: "company recruiter",
    alumni: "alumnus",
});
