// /api/v1/recruiters — recruiter (role "company") accounts invited by the TPO
// (docs/contracts/AUTH-FACULTY.md §7.3). Same shape and rules as /faculty;
// one-time passwords from copilot invites are redeemed at /faculty/reveal.
import { createProvisioningRouter } from "./faculty.routes.js";

export default createProvisioningRouter("company");
