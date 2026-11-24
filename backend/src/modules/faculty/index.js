// Module "faculty" (docs/contracts/AUTH-FACULTY.md §7, §8, §10.1):
//   /api/v1/faculty     teacher accounts (TPO/admin)  + POST /reveal
//   /api/v1/recruiters  recruiter accounts (TPO/admin)
//   /api/v1/colleges    the caller's college; admin college management
//   tools: faculty_list, faculty_invite, recruiters_list, recruiter_invite
import facultyRouter from "./faculty.routes.js";
import recruitersRouter from "./recruiters.routes.js";
import collegesRouter from "./colleges.routes.js";
import tools from "./tools.js";

export {
    inviteUser,
    listProvisioned,
    resolveActorCollege,
    resolveCompany,
    toFacultyDTO,
    toRecruiterDTO,
} from "./provisioning.service.js";
export { putReveal, takeReveal } from "./reveal-store.js";

export default {
    name: "faculty",
    mountPath: "/api/v1/faculty",
    router: facultyRouter,
    routers: [
        { path: "/api/v1/recruiters", router: recruitersRouter },
        { path: "/api/v1/colleges", router: collegesRouter },
    ],
    tools,
};
