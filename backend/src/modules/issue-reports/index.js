// Module "issue-reports" (docs/contracts/AUTH-FACULTY.md §9, §10.2):
// anonymous or signed-in bug reports, triaged by the TPO/admin in the
// tpo.issues panel; copilot tool issue_report_create.
import router from "./issue-reports.routes.js";
import tools from "./tools.js";

export { IssueReport, ISSUE_STATUSES } from "./issue-report.model.js";
export { createIssueReport, listIssueReports, updateIssueReport } from "./issue-reports.service.js";

export default {
    name: "issue-reports",
    mountPath: "/api/v1/issue-reports",
    router,
    tools,
};
