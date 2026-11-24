# Integration contracts — index, ownership and resolved conflicts

These documents are the source of truth for the "Matchy Campus" integration (SIH placement platform +
Matchy job feed / resume lab / BYOK + attendance + tool-calling copilot). Implementers build against them;
when a contract is ambiguous the implementer picks the most sensible behaviour and records it as a deviation.

| Contract | Scope |
|---|---|
| [AGENT-TOOLS.md](AGENT-TOOLS.md) | Copilot ↔ Node tool protocol, tool token, manifest/execute/audit, **tool catalogue (single source of tool names)**, copilot wire format |
| [UI-ACTIONS.md](UI-ACTIONS.md) | **Single source of panel ids**, role → panel allow-lists, `applyUiActions` semantics |
| [ATTENDANCE.md](ATTENDANCE.md) | Courses, sessions, rotating single-use QR, scheduling, reports, attendance tools |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | `notify()` fan-out, realtime/email/web-push, notification REST |
| [PLACEMENTS.md](PLACEMENTS.md) | Campus drives, applications, eligibility, offers + policy, training, recruiters' drives, stats, interviews routes |
| [JOB-FEED.md](JOB-FEED.md) | Matchy job aggregation as `ExternalJob`, tracker, sync, WhatsApp (optional), jobs-finder replacement (§12) |
| [RESUME-BYOK.md](RESUME-BYOK.md) | Unified resumes, storage drivers, Tectonic, upload + ATS score, BYOK keys + surgical tailoring |
| [AUTH-FACULTY.md](AUTH-FACULTY.md) | Login/roles/sessions, Google sign-in, reset, faculty + recruiter provisioning, issue reports, demo seed |
| [PYTHON.md](PYTHON.md) | Agent service: copilot, role-aware routing, Gemini client, hardening, agent fixes |
| [FRONTEND.md](FRONTEND.md) | Frontend architecture, **exhaustive frontend file ownership (§2)**, component contracts, API client modules |

## Implementation order
1. **Backend foundation:** notifications, agent-tools registry. Python service (independent of Node code).
2. **Backend features:** attendance, placements, job-feed, resume-byok, auth-faculty.
3. **Frontend:** shell first; feature roles after the backend they call exists — they VERIFY every path and
   response shape against the implemented routes (`backend/src/modules/*/routes*.js`, `backend/src/routes/*.js`),
   not only against the contract text.
4. **Integration** (integrator): demo seed, `.env.example` files, cross-module fixes, end-to-end checks.

## Backend + Python ownership (every file has exactly one owner)
| Owner | Files |
|---|---|
| **integrator** | `backend/src/core/*`, `backend/src/modules/index.js`, `backend/src/app.js`, `backend/src/index.js`, `backend/src/config/config.js`, `backend/src/db/db.js`, `backend/src/websocket/{socket-server,ai-query-handler,intent-router}.js`, `backend/test/helpers.js`, `backend/test/core.test.js`, `backend/test/contract/*`, `backend/package.json`, `backend/.env.example`, `backend/.gitignore`, `backend/scripts/seed-demo.js` (written in the integration step from AUTH-FACULTY §seed), repository root files, `docs/contracts/*` |
| **notifications** | `backend/src/modules/notifications/**`, `backend/test/notifications*.test.js` |
| **agent-tools** | `backend/src/modules/agent-tools/**`, `backend/test/agent-tools*.test.js` |
| **attendance** | `backend/src/modules/attendance/**`, `backend/test/attendance*.test.js` |
| **placements** | `backend/src/modules/placements/**`, `backend/src/models/job.models.js`, `backend/src/models/company.models.js`, `backend/src/websocket/job-service.js`, `backend/src/websocket/metadata-builder.js`, `backend/src/routes/interview.routes.js`, `backend/src/services/interview.service.js`, `backend/src/utils/dates.js` (new), `backend/test/placements*.test.js` |
| **job-feed** | `backend/src/modules/job-feed/**`, `backend/scripts/job-feed-whatsapp.js`, `backend/test/job-feed*.test.js`, `docs/JOB-FEED-OPERATIONS.md` |
| **resume-byok** | `backend/src/modules/resume-lab/**`, `backend/src/modules/byok/**`, `backend/src/models/resume.models.js`, `backend/src/services/resume-bank.service.js`, `backend/src/routes/resume-bank.routes.js`, `backend/src/routes/alumni.routes.js` (RESUME-BYOK §13 share changes only), `backend/scripts/install-tectonic.js`, `backend/scripts/migrate-resumes.js`, `backend/test/resume*.test.js`, `backend/test/byok*.test.js` |
| **auth-faculty** | `backend/src/modules/faculty/**`, `backend/src/modules/issue-reports/**`, `backend/src/controllers/auth.controller.js`, `backend/src/routes/auth.routes.js`, `backend/src/middlewares/auth.middleware.js`, `backend/src/websocket/auth-context.js`, `backend/src/models/user.models.js` (AUTH-FACULTY §2.1 edits), `backend/src/models/auth-session.models.js`, `backend/src/models/college.models.js`, `backend/src/services/user-profile.service.js`, `backend/src/controllers/ggsipu.controller.js`, `backend/src/routes/ggsipu.routes.js`, `backend/src/validations/*`, `backend/src/controllers/google-gmail.controller.js` if AUTH-FACULTY touches it, `backend/test/auth*.test.js`, `backend/test/faculty*.test.js`, `backend/test/issue-reports*.test.js` |
| **python** | everything under `ai-service/` |
| **frontend** | per FRONTEND.md §2 (shell, attendance-teacher, attendance-student, opportunities, resume, tpo) |

Legacy files not listed (e.g. alumni/pr-outreach/ggsipu services, other models) are not to be edited; if a change is
needed, the implementer reports it to the integrator.

## Conflicts resolved by the integrator
1. **Shared seams already applied** (do not re-apply): User fields `activeBacklogs`, `tenthPercentage`,
   `twelfthPercentage` (PLACEMENTS §3.7) and `llmCredentials[].keyHint` (RESUME-BYOK); AUTH-FACULTY §13 env exports in
   `config/config.js` (`TEACHER_EMAILS` Set, `GOOGLE_REQUIRE_HOSTED_DOMAIN`, `AUTH_COOKIE_SAMESITE`,
   `PASSWORD_RESET_TTL_MINUTES`, `TEMP_PASSWORD_TTL_DAYS`); the relay passes `draftId: payload.data?.draft_id` to
   `persistConfirmedJob` and forwards `details.ui_context` → `meta_data.ui_context` and `details.selected_job` →
   `meta_data.selected_job` (PYTHON.md §9).
2. `websocket/auth-context.js` is owned by **auth-faculty**, which also implements PLACEMENTS §8's `buildProfile`
   rule (stored academic fields win over client `details`).
3. `services/user-profile.service.js` is created by **auth-faculty** and must already contain PLACEMENTS §3.7's three
   student-only rows; placements does not edit it.
4. `services/resume-bank.service.js` is owned by **resume-byok**; placements calls its exports only.
5. Tests: every backend test uses the shared harness `backend/test/helpers.js` (local MongoDB, one throw-away DB per
   file). Do NOT add mongodb-memory-server or a second harness (PLACEMENTS §16's harness section is superseded).
6. Panel ids come only from UI-ACTIONS.md. `tpo.jobfeed` is an alias — producers send `tpo.job-feed`. `tpo.recruiters`
   is registered (AUTH-FACULTY recruiter tools).
7. Tool names come only from AGENT-TOOLS.md §5 plus the extensions their area contract declares (e.g. AUTH-FACULTY
   `recruiters_list`, `recruiter_invite`); every tool is implemented by exactly one module.
8. Package scripts and `.env.example` entries requested by contracts are added by the integrator after the files exist.
9. Acceptance tests owned by the integrator: `backend/test/contract/attendance.contract.test.js` and
   `backend/test/contract/agent-tools.contract.test.js` must pass once attendance + agent-tools land.

## Open questions for the product owner (defaults applied until answered)
Each contract ends with its own list; the defaults described there are implemented.
