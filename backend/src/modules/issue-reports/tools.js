// Copilot tool of the issue-reports module (docs/contracts/AUTH-FACULTY.md §10.2):
// issue_report_create — an AUTH-FACULTY extension of the AGENT-TOOLS catalogue.
import { createIssueReport } from "./issue-reports.service.js";

const clip = (value, max) => {
    const text = String(value ?? "").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export default [
    {
        name: "issue_report_create",
        description: "File a bug or problem report with the placement team on the user's behalf — e.g. 'the QR scanner "
            + "keeps failing, report it'. Use the user's own words for the description.",
        roles: ["student", "teacher", "tpo", "company", "admin", "alumni"],
        confirm: true,
        parameters: {
            type: "object",
            properties: {
                description: { type: "string", description: "What went wrong, in the user's words" },
                page: { type: "string", description: "Screen or feature where it happened" },
            },
            required: ["description"],
        },
        preview: async (args) => ({
            summary: `File this issue report for the placement team? '${clip(args.description, 120)}'`,
            args: {
                description: String(args.description ?? "").trim(),
                ...(typeof args.page === "string" && args.page.trim() ? { page: args.page.trim() } : {}),
            },
        }),
        handler: async (args, ctx) => {
            const { id } = await createIssueReport({
                user: ctx.user,
                body: { description: args.description, page: args.page },
                userAgent: "copilot",
            });
            return {
                summary: `Filed your issue report #${id.slice(-6)}. The placement team will review it.`,
                data: { id },
            };
        },
    },
];
