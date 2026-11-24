# Contract — UI actions & panel registry (right-hand workspace)

Every way of changing what the right-hand workspace shows goes through ONE mechanism: a **UI action**
applied by `applyUiActions()` (frontend `src/workspace/uiActions.js`). Copilot tool results
(`data.ui_actions`, see AGENT-TOOLS.md §6), notification clicks (`Notification.ui`, see
NOTIFICATIONS.md), legacy agent headers, deep links and the user's own clicks (tiles, tabs, back
buttons) all produce UI actions. This file is the single source of truth for panel ids, the state
each panel maps to, who may open it, the params it accepts and the component that renders it.
FRONTEND.md references this file; on any conflict about panels, THIS file wins.

## 1. Shape of a UI action

```js
{
  id?: string,        // unique per producer; used for dedupe (see §6). Copilot: "<tool_call_id>:<n>".
  panel: string,      // a panel id from §3, e.g. "teacher.live"
  params?: object,    // panel params (§3, typed in §5). Unknown keys are dropped, invalid values dropped.
  data?: any,         // optional JSON payload already fetched by the producer (e.g. tailoring patches).
}
```
- Producers MUST use canonical param names (§5): `sessionId`, `courseId`, `jobId`, `source`,
  `applicationId`, `offerId`, `programId`, `resumeId`, `jobSource`, `credentialId`, `status`,
  `query`, `category`, `jobType`, `threshold`, `days`, `date`, `tab`. Ids are strings (Mongo ObjectId hex).
- Backend tool handlers return it as `ui` (object or array) — AGENT-TOOLS.md §2/§3. The copilot
  forwards each as `ui_actions[i] = {id, panel, params, data?}`.
- Notifications store it as `Notification.ui` (`{panel, params}`; `id`/`data` not stored).
- `data` must be JSON and small (< 100 KB). It is stored in Redux, never in localStorage.

## 2. Producers and how they are applied

| source | where | id / dedupe | params absent means | mobile behaviour |
|---|---|---|---|---|
| `copilot` | `aiRequestHandler.handleResponse` for every `copilot:*` chunk with `data.ui_actions` | dedupe key `"<requestId>:<action.id>"` (actions are cumulative per request; each applies once, in array order, as soon as it appears) | `{}` | does NOT switch the mobile pane; the chat message shows an "OPENED …" chip and the WORKSPACE tab gets an attention dot |
| `header` | legacy agent headers (table §8) | `"hdr:<requestId>:<panel>:<params.tab or ''>"` | `{}` | same as copilot |
| `notification` | click on a notification (bell list, toast "OPEN", web-push click → deep link) | none (fresh id each click) | `{}` | switches mobile pane to WORKSPACE |
| `deeplink` | `/?panel=…` on app load or service-worker `open-url` message (§9) | none | `{}` | switches mobile pane to WORKSPACE |
| `user` | `openPanel(panelId, params)` from tiles, tabs, back buttons, "VIEW" buttons | none | **keep the panel's existing params** | switches mobile pane to WORKSPACE |

## 3. Panel registry

Columns:
- **Target** — `mode:<activeMode>` plus exactly one of `feature:<activeFeature>` / `tab:<activeJobsTab>` /
  `tool:<activeResumeTool>`; `feature:—` means `activeFeature = null` (mode home).
  Overlays set `appContext.overlay` and leave mode/feature untouched.
- **Roles** — roles that may open the panel directly (`admin` always has exactly the `tpo` rights).
- **Aliases** — for a role NOT in Roles, the action is redirected to this panel (params pass through and
  are re-sanitized for the alias). No alias for the role → the action is skipped (`FORBIDDEN`).
- **Params** — see §5 for types; `*` = required (action skipped with `MISSING_PARAM` if absent after sanitizing).
- **Component** — path under `frontend/src/`, default export name, owner (FRONTEND.md §2).

### 3.1 Student mode (`mode:student`)

| Panel id | Title | Target | Roles | Aliases | Params | Component (owner) |
|---|---|---|---|---|---|---|
| `student.home` | Student home | mode:student feature:— | student | – | – | `pages/StudentMode.jsx` `StudentMode` home grid (shell) |
| `jobs.matched` | AI-matched jobs | mode:student feature:drives tab:matched | student | – | – | `features/opportunities/JobsHub.jsx` `JobsHub` (opportunities) |
| `jobs.campus` | Campus drives | mode:student feature:drives tab:campus | student | tpo→`tpo.drives`, admin→`tpo.drives`, company→`company.drives` | `query` string, `location` string, `minPackageLpa` number, `eligibleOnly` boolean | `JobsHub` (opportunities) |
| `jobs.market` | Open-market jobs | mode:student feature:drives tab:market | student | tpo→`tpo.job-feed`, admin→`tpo.job-feed` | `query` string (key alias `q`), `category` string, `jobType` enum(full-time, part-time, internship, contract), `workType` enum(onsite, remote, hybrid), `location` string, `source` string, `sort` enum(newest, match), `highlightIds` idList, `page` integer(1..1000) | `JobsHub` (opportunities) |
| `jobs.tracker` | Saved & applied | mode:student feature:drives tab:tracker | student | – | `status` enum(saved, applied, interviewing, offer, rejected), `highlightId` id | `JobsHub` (opportunities) |
| `jobs.detail` | Job details | mode:student feature:drives tab:detail | student | tpo→`tpo.drives`, admin→`tpo.drives`, company→`company.drives` | `jobId`* id, `source` enum(campus, market) default campus, `from` enum(matched, campus, market, tracker) | `JobsHub` (opportunities) |
| `applications` | My applications | mode:student feature:applications | student | tpo→`tpo.applicants`, admin→`tpo.applicants`, company→`company.applicants` | `status` string, `applicationId` id | `features/opportunities/ApplicationsPanel.jsx` `ApplicationsPanel` (opportunities) |
| `offers` | My offers | mode:student feature:offers | student | tpo→`tpo.offers`, admin→`tpo.offers` | `offerId` id, `status` string | `components/StudentOffers.jsx` `StudentOffers` (opportunities) |
| `training` | Training programs | mode:student feature:training | student | tpo→`tpo.training`, admin→`tpo.training` | `tab` enum(discover, mine) default discover, `programId` id | `components/TrainingHub.jsx` `TrainingHub` (opportunities) |
| `calendar` | Placement calendar | mode:student feature:calendar | student | tpo→`tpo.calendar`, admin→`tpo.calendar` | `date` date | `features/opportunities/CalendarPanel.jsx` `CalendarPanel` (opportunities) |
| `portfolio` | My portfolio | mode:student feature:portfolio | student | – | `tab` enum(profile, projects, experience) default profile | inline in `pages/StudentMode.jsx` (shell) |
| `attendance.student` | My attendance | mode:student feature:attendance | student | teacher→`teacher.courses`, tpo→`tpo.attendance`, admin→`tpo.attendance` | `courseId` id, `tab` enum(overview, history) default overview | `features/attendance/student/StudentAttendancePanel.jsx` `StudentAttendancePanel` (attendance-student) |
| `attendance.scan` | Scan attendance QR | mode:student feature:attendance-scan | student | – | – | `features/attendance/student/ScanPanel.jsx` `ScanPanel` (attendance-student) |
| `schedule` | Class schedule | mode:student feature:schedule | student | teacher→`teacher.schedule` | `days` integer(1..31) default 7, `date` date | `features/attendance/student/StudentSchedulePanel.jsx` `StudentSchedulePanel` (attendance-student) |
| `interview` | AI mock interview | mode:student feature:mock-interview | student | – | – | `components/InterviewWorkspace.jsx` `InterviewWorkspace` (shell) |
| `learning` | Learning roadmap | mode:student feature:learning-recommendation | student | – | `interviewId` id | `components/LearningRecommendationWorkspace.jsx` `LearningRecommendationWorkspace` (shell) |

### 3.2 Resume Lab (`mode:resume`)

| Panel id | Title | Target | Roles | Aliases | Params | Component (owner) |
|---|---|---|---|---|---|---|
| `resume.home` | Resume Lab | mode:resume tool:null | student | – | – | `pages/ResumeStudio.jsx` `ResumeStudio` home grid (resume) |
| `resume.lab` | Resume Lab tool | mode:resume tool:`<params.tab>` | student | – | `tab` enum(catalog, editor, tailor, ats, generator, skill-gap) default catalog, `resumeId` id, `jobId` id, `jobSource` enum(campus, market), `credentialId` id | `ResumeStudio` → per-tab component (resume) |
| `settings.ai-keys` | AI keys (BYOK) | mode:resume tool:ai-keys | student | – | `provider` enum(openai, anthropic, google, xai) | `features/resume/AiKeysPanel.jsx` `AiKeysPanel`, rendered by `ResumeStudio` (resume) |

`resume.lab` with `tab` ∈ {generator, editor, tailor} is a **full-height** panel (the right column stops
scrolling; the panel manages its own scroll).

### 3.3 Other student modes

| Panel id | Title | Target | Roles | Aliases | Params | Component (owner) |
|---|---|---|---|---|---|---|
| `alumni` | Alumni connect | student → mode:alumni_connect; alumni → mode:alumni | student, alumni | – | – | `pages/AlumniConnect.jsx` `AlumniConnect` `{user, alumniMode: activeMode==="alumni"}` (shell) |
| `pr-outreach` | PR & outreach | mode:pr_outreach | student, tpo, admin | – | – | `pages/PROutreach.jsx` `PROutreach` (shell) |

### 3.4 Teacher mode (`mode:teacher`)

| Panel id | Title | Target | Roles | Aliases | Params | Component (owner) |
|---|---|---|---|---|---|---|
| `teacher.home` | Teacher home | mode:teacher feature:— | teacher | – | – | `pages/TeacherMode.jsx` `TeacherMode` home (attendance-teacher) |
| `teacher.courses` | My courses | mode:teacher feature:courses | teacher | tpo→`tpo.attendance`, admin→`tpo.attendance` | `courseId` id, `tab` enum(overview, students, timetable, settings) default overview, `create` boolean | `features/attendance/teacher/CoursesPanel.jsx` (attendance-teacher) |
| `teacher.schedule` | Class schedule | mode:teacher feature:schedule | teacher | – | `sessionId` id, `courseId` id, `date` date, `view` enum(list, week) default list, `create` boolean | `features/attendance/teacher/SchedulePanel.jsx` (attendance-teacher) |
| `teacher.live` | Live attendance | mode:teacher feature:live | teacher | – | `sessionId` id (absent → picker of live/today's sessions) | `features/attendance/teacher/LiveSessionPanel.jsx` (attendance-teacher) |
| `teacher.report` | Session report | mode:teacher feature:report | teacher | tpo→`tpo.attendance`, admin→`tpo.attendance` | `sessionId` id, `courseId` id, `date` date | `features/attendance/teacher/SessionReportPanel.jsx` (attendance-teacher) |
| `teacher.analytics` | Course analytics | mode:teacher feature:analytics | teacher | tpo→`tpo.attendance`, admin→`tpo.attendance` | `courseId` id, `threshold` number(0..100) | `features/attendance/teacher/CourseAnalyticsPanel.jsx` (attendance-teacher) |

`TeacherMode` renders these five internal components itself; the shell only imports `TeacherMode`.

### 3.5 TPO mode (`mode:tpo`, roles tpo + admin)

| Panel id | Title | Target | Roles | Aliases | Params | Component (owner) |
|---|---|---|---|---|---|---|
| `tpo.home` | TPO home | mode:tpo feature:— | tpo, admin | – | – | `pages/AdminMode.jsx` `AdminMode` tool grid (shell) |
| `tpo.job-creator` | AI job creator | mode:tpo feature:job-creator | tpo, admin | – | – | inline `JobCreatorPanel` in `pages/AdminMode.jsx` (shell) |
| `tpo.gap-analysis` | Curriculum gap analysis | mode:tpo feature:gap-analysis | tpo, admin | – | – | `components/GapAnalysisPanel.jsx` `GapAnalysisPanel` (tpo) |
| `tpo.drives` | Placement drives | mode:tpo feature:job-postings | tpo, admin | company→`company.drives` | `jobId` id, `status` string, `query` string, `create` boolean | `features/tpo/DrivesPanel.jsx` `DrivesPanel` `{scope:"tpo"}` (tpo) |
| `tpo.applicants` | Applicants | mode:tpo feature:application-review | tpo, admin | company→`company.applicants` | `jobId` id, `status` string, `applicationId` id | `features/tpo/ApplicantsPanel.jsx` `ApplicantsPanel` `{scope:"tpo"}` (tpo) |
| `tpo.offers` | Offer management | mode:tpo feature:offer-management | tpo, admin | company→`company.applicants` | `status` string, `offerId` id, `applicationId` id, `create` boolean | `components/OfferManagement.jsx` `OfferManagement` (tpo) |
| `tpo.policy` | Placement policy | mode:tpo feature:policy-configuration | tpo, admin | – | `academicYear` string | `components/PolicyConfigPanel.jsx` `PolicyConfigPanel` (tpo) |
| `tpo.analytics` | Placement analytics | mode:tpo feature:placement-analytics | tpo, admin | – | `academicYear` string, `branch` string | `features/tpo/PlacementAnalyticsPanel.jsx` `PlacementAnalyticsPanel` (tpo) |
| `tpo.training` | Training scheduler | mode:tpo feature:training-scheduler | tpo, admin | – | `programId` id, `create` boolean | `components/TrainingScheduler.jsx` `TrainingScheduler` (tpo) |
| `tpo.calendar` | Drive calendar | mode:tpo feature:placement-calendar | tpo, admin | – | `date` date | `features/tpo/TpoCalendarPanel.jsx` `TpoCalendarPanel` (tpo) |
| `tpo.job-feed` | Job feed (market) | mode:tpo feature:job-feed | tpo, admin | – | `runId` id, `query` string (key alias `q`), `category` string, `jobType` enum(full-time, part-time, internship, contract), `workType` enum(onsite, remote, hybrid), `location` string, `source` string, `sort` enum(newest, match) | `features/tpo/JobFeedAdminPanel.jsx` `JobFeedAdminPanel` (tpo) |
| `tpo.faculty` | Faculty | mode:tpo feature:faculty | tpo, admin | – | `query` string, `facultyId` id, `invite` boolean | `features/tpo/FacultyPanel.jsx` `FacultyPanel` (tpo) |
| `tpo.recruiters` | Recruiters | mode:tpo feature:recruiters | tpo, admin | – | `query` string, `recruiterId` id, `invite` boolean, `highlightId` id, `revealInviteId` id | `features/tpo/RecruitersPanel.jsx` `RecruitersPanel` (tpo) — recruiter accounts per AUTH-FACULTY.md (recruiters_list / recruiter_invite tools) |
| `tpo.attendance` | Attendance oversight | mode:tpo feature:attendance-oversight | tpo, admin | – | `courseId` id, `sessionId` id, `threshold` number(0..100) | `features/attendance/teacher/AttendanceOversightPanel.jsx` `AttendanceOversightPanel` (attendance-teacher) |
| `tpo.issues` | Issue reports | mode:tpo feature:issue-reports | tpo, admin | – | `status` string, `reportId` id | `features/tpo/IssueReportsPanel.jsx` `IssueReportsPanel` (tpo) |

### 3.6 Company mode (`mode:company`)

| Panel id | Title | Target | Roles | Aliases | Params | Component (owner) |
|---|---|---|---|---|---|---|
| `company.home` | Recruiter home | mode:company feature:— | company | – | – | `pages/CompanyMode.jsx` `CompanyMode` home (tpo) |
| `company.drives` | My drives | mode:company feature:drives | company | – | `jobId` id, `status` string, `query` string, `create` boolean | `DrivesPanel` `{scope:"company"}` rendered by `CompanyMode` (tpo) |
| `company.applicants` | Applicants | mode:company feature:applicants | company | – | `jobId` id, `status` string, `applicationId` id | `ApplicantsPanel` `{scope:"company"}` rendered by `CompanyMode` (tpo) |

### 3.7 Overlays (every role)

| Panel id | Title | Target | Roles | Params | Component (owner) |
|---|---|---|---|---|---|
| `notifications` | Notifications | overlay:notifications | all | `tab` enum(inbox, preferences) default inbox | `features/notifications/NotificationPanel.jsx` `NotificationPanel` (shell) |
| `profile` | Edit profile | overlay:profile | all | `tab` string | `components/ProfileModal.jsx` `ProfileModal` (shell) |
| `report-issue` | Report an issue | overlay:report-issue | all | `description` text | `features/help/ReportIssueModal.jsx` `ReportIssueModal` (shell) |

"all" = student, teacher, tpo, admin, company, alumni. Opening a workspace panel closes any open overlay.

### 3.8 Deprecated panel ids (accepted, rewritten before resolution)

| received id | rewritten to | why |
|---|---|---|
| `tpo.jobfeed` | `tpo.job-feed` | JOB-FEED.md §9.2/§13 draft spelling; producers SHOULD send `tpo.job-feed` |

`PANEL_ID_ALIASES` in `src/workspace/panels.js` holds this map; the applier rewrites the id first, then
resolves roles/aliases as usual. Do not add new entries without updating this table.

## 4. Panels per role (enum for `open_panel`, AGENT-TOOLS.md §4)

The backend `open_panel` tool MUST offer exactly these ids per role (direct panels only; aliases are a
frontend safety net). The frontend exports the same object as `PANELS_BY_ROLE` from
`src/workspace/panels.js`, and a test asserts it equals this block.

```json
{
  "student": ["student.home", "jobs.matched", "jobs.campus", "jobs.market", "jobs.tracker", "jobs.detail",
              "applications", "offers", "training", "calendar", "portfolio",
              "attendance.student", "attendance.scan", "schedule", "interview", "learning",
              "resume.home", "resume.lab", "settings.ai-keys", "alumni", "pr-outreach",
              "notifications", "profile", "report-issue"],
  "teacher": ["teacher.home", "teacher.courses", "teacher.schedule", "teacher.live", "teacher.report",
              "teacher.analytics", "notifications", "profile", "report-issue"],
  "tpo":     ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
              "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
              "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"],
  "admin":   ["tpo.home", "tpo.job-creator", "tpo.gap-analysis", "tpo.drives", "tpo.applicants", "tpo.offers",
              "tpo.policy", "tpo.analytics", "tpo.training", "tpo.calendar", "tpo.job-feed", "tpo.faculty",
              "tpo.recruiters", "tpo.attendance", "tpo.issues", "pr-outreach", "notifications", "profile", "report-issue"],
  "company": ["company.home", "company.drives", "company.applicants", "notifications", "profile", "report-issue"],
  "alumni":  ["alumni", "notifications", "profile", "report-issue"]
}
```

Mode home per mode (used by the mode dropdown, `switchMode()` and "BACK TO … HOME" buttons):
`student → student.home`, `resume → resume.home`, `pr_outreach → pr-outreach`, `alumni_connect → alumni`,
`alumni → alumni`, `teacher → teacher.home`, `tpo → tpo.home`, `company → company.home`.

## 5. Param types and sanitization (`sanitizeParams(panel, params)`)

| type | accepts | stored as |
|---|---|---|
| `id` | string matching `^[A-Za-z0-9_:.-]{1,64}$` (numbers are stringified) | string |
| `string` | any scalar; trimmed; 1..200 chars | string |
| `text` | any scalar; trimmed; 1..2000 chars | string |
| `number(min..max)` | number or numeric string, finite, clamped to range | number |
| `integer(min..max)` | as number, then `Math.round` | number |
| `boolean` | `true/false`, `"true"/"false"`, `1/0` | boolean |
| `enum(a, b, …)` | exact (case-insensitive) member | lower-case member |
| `date` | `YYYY-MM-DD` or a parseable ISO datetime | the original string |
| `idList` | array (or comma-separated string) of `id` values; invalid entries dropped; max 20 | string[] (omitted when empty) |

Rules: a declared **key alias** is renamed first (`q` → `query` on `jobs.market` and `tpo.job-feed`; when
both are present `query` wins); keys not declared for the panel are dropped; values failing their type
are dropped (never an error); declared defaults are filled in; required params (`*`) missing after this →
the action is skipped with reason `MISSING_PARAM`. Sanitization runs again after alias redirection,
against the alias panel's declaration.

## 6. `applyUiActions(actions, opts)` — exact algorithm

File `src/workspace/uiActions.js` (owner: shell). Pure core `createUiActionApplier({ getState, dispatch })`
plus a bound instance (`bindUiActions(store)` is called once in `main.jsx`).

```js
applyUiActions(actions, { source = "user", requestId = null, role } = {})
  → { applied: [{ id, panel }], skipped: [{ id, panel, reason }] }
// reason ∈ "INVALID" | "DUPLICATE" | "UNKNOWN_PANEL" | "FORBIDDEN" | "MISSING_PARAM" | "NOT_BOUND"
openPanel(panelId, params /* undefined = keep current params */, { data } = {})
  → applyUiActions([{ id: uid(), panel: panelId, params, data }], { source: "user" })
```

1. Normalize: accept one object or an array; drop entries that are not objects or lack a string `panel` (`INVALID`).
2. Ids: for `copilot` the dedupe key is `${requestId}:${action.id ?? index}`; for `header` the caller passes
   the id from §2; for every other source a fresh `uid()` is used (never deduped).
3. Dedupe (copilot/header only): skip keys already in the module-level `appliedKeys` set (FIFO, cap 500)
   and duplicates inside the same batch (`DUPLICATE`).
4. Role: `opts.role ?? state.appContext.userRole`. Rewrite deprecated ids (§3.8), then resolve
   `PANELS[panel]` (`UNKNOWN_PANEL` if absent).
   If the role is not in `roles`, follow `aliases[role]` (at most 2 hops); still not allowed → `FORBIDDEN`.
5. Params: if `params === undefined` and `source === "user"` → reuse `state.appContext.panelParams[panelId]`;
   otherwise `sanitizeParams(target, params ?? {})`; required missing → `MISSING_PARAM`.
6. Dispatch, in order, ONE `panelOpened({ panelId, target, params, data, actionId, source })` per action
   (appContextSlice). The reducer:
   - workspace target: sets `activeMode` (for `alumni` the mode comes from `modeByRole[role]`),
     `activeFeature` (`null` for homes; untouched for `resume.*`/`settings.*`/`alumni`/`pr-outreach`),
     `activeJobsTab` (jobs panels), `activeResumeTool` (`resume.home` → `null`, `resume.lab` → `params.tab`,
     `settings.ai-keys` → `"ai-keys"`), closes `overlay`;
   - overlay target: sets `overlay = target.overlay` only;
   - always: `activePanel = panelId` (workspace targets only), `panelParams[panelId] = params`,
     `panelData[panelId] = data` when `data !== undefined`, otherwise deletes `panelData[panelId]`,
     `panelNonce[panelId] += 1`, `lastUiAction = { id, panelId, source, at: ISO }`;
   - sources `user`/`notification`/`deeplink` set `mobilePane = "workspace"`; `copilot`/`header` set
     `workspaceAttention = true` instead (cleared when the user opens the workspace pane).
   After a workspace target that changes mode, the applier also dispatches `modeChosen()` (session slice,
   so deep links skip the welcome screen) and writes `localStorage.activeMode` (via `src/lib/storage.js`).
7. `applyUiActions` never changes `agentMode` (only `switchMode()` and header routing do).
8. In development (`import.meta.env.DEV`) every skipped action is `console.warn`ed with its reason;
   nothing is shown to the user.

## 7. Consuming panel params in components

```js
import { usePanel, openPanel } from "../../workspace/index.js";

export default function CourseAnalyticsPanel() {
  const { params, data, nonce, setParams } = usePanel("teacher.analytics");
  // Reset local state whenever a NEW action targets this panel or the entity changes:
  return <CourseAnalyticsView key={`${params.courseId ?? "none"}:${nonce}`} courseId={params.courseId}
            threshold={params.threshold} onPickCourse={(courseId) => setParams({ courseId })} />;
}
```
- `usePanel(panelId)` (`src/workspace/usePanel.js`) → `{ params, data, nonce, active, setParams(patch, {replace=false}), clearData() }`.
  `params` is a stable frozen `{}` when unset. `setParams` sanitizes, MERGES by default and does not bump `nonce`.
- Components NEVER read `state.appContext.panelParams` directly and never dispatch `panelOpened` themselves.
- Navigation between panels: always `openPanel(id, params)` — e.g. Schedule → "START" →
  `openPanel("teacher.live", { sessionId })`; tab bars call `openPanel("jobs.market")` (keeps filters).
- When the user picks an entity inside a panel, call `setParams({ courseId })` so the copilot's
  `ui_context` (FRONTEND.md §8.7) stays truthful.
- One-shot `data` (e.g. tailoring patches): read it in render as an initial value for a keyed child
  (`useState(() => data?.patches ?? [])`); never copy it into state inside an effect. Call `clearData()`
  only after the user acts on it (accept/discard).
- Lint (react-hooks v7): no synchronous `setState` in effect bodies, no `Date.now()` in render, no
  `ref.current` reads in render — use the key-reset pattern above and `useAsync` (`src/ui/useAsync.js`).

## 8. Legacy agent headers → UI actions (`src/workspace/headerRoutes.js`, owner shell)

Applied by `aiRequestHandler.handleResponse` with `source: "header"`; role-checked like any action
(this fixes the old bug where TPOs were forced into student mode and students into TPO mode).

| header_message | condition | action |
|---|---|---|
| `mode:jobparser:jobslist` | `Array.isArray(data) && data.length > 0` | `{panel:"jobs.matched"}` |
| `mode:jobparser:eligibility` | – | `{panel:"jobs.campus"}` |
| `mode:jobparser:addjob:wishlist` | `data.type==="wishlist"` and `data.ui` is an object | `data.ui` as-is (JOB-FEED.md §12.8; the tool's own `ui`, e.g. `jobs.tracker`) |
| `mode:jobparser:jobdetails`, `mode:jobparser:addjob:wishlist` (otherwise), `mode:switch:jobs`, `mode:switch:resume`, `mode:switch:job-eligibility`, `mode:switch:job-creation`, `mode:none` | – | none |
| `resume_generator`, `resume-generator` | `data.type==="analysis"` | `{panel:"resume.lab", params:{tab: data.analysis_type==="gap" ? "skill-gap" : "ats"}}` |
| `resume_generator`, `resume-generator` | otherwise | `{panel:"resume.lab", params:{tab:"generator"}}` |
| `mode:jobCreation:data` / `:ready` / `:post` / `:error` | – | `{panel:"tpo.job-creator"}` |
| `mode:switch:pr-outreach`, `mail:review`, `pr_outreach_satisfied` | – | `{panel:"pr-outreach"}` |
| `mode:switch:alumni-connect`, `alumni:matches`, `alumni:request-review`, `alumni:resume-share-review` | – | `{panel:"alumni"}` |
| `mode:switch:ai-interviewer`, `button:options`, `select:job:db`, `text:mode:interview`, `interview:end` | – | `{panel:"interview"}` |
| `mode:switch:gap-analysis`, `mode:gapAnalysis:analysis`, `mode:gapAnalysis:suggestions`, `mode:gapAnalysis:error` | – | `{panel:"tpo.gap-analysis"}` |
| `mode:switch:learning-recommendation`, `select:interview:db`, `learning:recommendations`, `learning:recommendations-error` | – | `{panel:"learning"}` |
| `copilot:thinking` / `:tool` / `:answer` / `:confirm` / `:error` | `Array.isArray(data.ui_actions)` | each element of `data.ui_actions` (`source:"copilot"`) |

## 9. Deep links (`src/workspace/deepLink.js`, owner shell)

```
${FRONTEND_URL}/?panel=<panelId>&params=<encodeURIComponent(JSON.stringify(params))>&nid=<notificationId>
```
- `buildPanelUrl({panel, params}, { origin = window.location.origin, notificationId })` and
  `parsePanelUrl(search)` → `{ panel, params, nid } | null` (malformed `params` JSON → `{}`; missing `panel` → `null`).
- The shell applies a parsed link once the session is authenticated (`source:"deeplink"`), marks `nid` read
  (best effort), then removes ONLY `panel`, `params`, `nid` from the URL with `history.replaceState`
  (other query keys such as `gmail_connected` stay for their consumers).
- Web push: the service worker opens/focuses this URL; a focused client receives
  `postMessage({ type: "open-url", url })` and the shell parses and applies it.
- The backend builds the same URL for push payloads (`notify()` push `url`, NOTIFICATIONS.md) — never a
  cross-origin URL; the service worker ignores non-same-origin URLs.

## 10. Agent tools → UI actions (what backend tool handlers return as `ui`)

| tool (AGENT-TOOLS.md §5) | student | teacher | tpo / admin | company |
|---|---|---|---|---|
| `open_panel` | `{panel, params}` as requested | same | same | same |
| `attendance_list_courses` | `attendance.student` | `teacher.courses` | `tpo.attendance` | – |
| `attendance_create_course` | – | `teacher.courses {courseId}` | – | – |
| `attendance_list_sessions` | `schedule` | `teacher.schedule {courseId}` | `tpo.attendance {courseId}` | – |
| `attendance_schedule_class`, `attendance_auto_schedule_class`, `attendance_reschedule_class` | – | `teacher.schedule {sessionId}` | – | – |
| `attendance_cancel_class` | – | `teacher.schedule {courseId}` | – | – |
| `attendance_start_session` | – | `teacher.live {sessionId}` | – | – |
| `attendance_end_session`, `attendance_mark_manual` | – | `teacher.report {sessionId}` | – | – |
| `attendance_session_report` | – | `teacher.report {sessionId}` | `tpo.attendance {sessionId}` | – |
| `attendance_course_report`, `attendance_notify_defaulters` | – | `teacher.analytics {courseId, threshold}` | `tpo.attendance {courseId, threshold}` | – |
| `attendance_my_summary`, `attendance_join_course` | `attendance.student {courseId?}` | – | – | – |
| `attendance_my_schedule` | `schedule {days}` | `teacher.schedule` | – | – |
| `attendance_open_scanner` | `attendance.scan` | – | – | – |
| `jobs_search_campus` | `jobs.campus {query, location, minPackageLpa, eligibleOnly}` | – | `tpo.drives {query}` | `company.drives {query}` |
| `job_details` | `jobs.detail {jobId, source:"campus"}` | – | `tpo.drives {jobId}` | `company.drives {jobId}` |
| `drive_apply`, `application_withdraw` | `applications {applicationId}` | – | – | – |
| `applications_list` | `applications {status}` | – | – | – |
| `offers_list`, `offer_respond` | `offers {offerId?}` | – | `tpo.offers {status?}` | – |
| `training_list`, `training_register` | `training {tab, programId?}` | – | `tpo.training` | – |
| `drives_list`, `drive_create`, `drive_close` | – | – | `tpo.drives {jobId?, status?}` | `company.drives {jobId?, status?}` |
| `applicants_list`, `application_update_status` | – | – | `tpo.applicants {jobId, applicationId?, status?}` | `company.applicants {…same}` |
| `offer_create` | – | – | `tpo.offers {offerId}` | `company.applicants {applicationId}` |
| `placement_stats` | – | – | `tpo.analytics` | – |
| `jobs_search_market` | `jobs.market {query, category, jobType, workType, location, source, sort}` | – | `tpo.job-feed {…same}` | – |
| `market_job_save`, `market_job_mark_applied` | `jobs.tracker {status, highlightId}` | – | – | – |
| `job_feed_sync` | – | – | `tpo.job-feed` | – |
| `resume_list` | `resume.lab {tab:"catalog"}` | – | – | – |
| `resume_score` | `resume.lab {tab:"ats", resumeId}` | – | – | – |
| `resume_tailor_for_job` | `resume.lab {tab:"tailor", resumeId, jobId, jobSource, credentialId?}` + `data` (below) | – | – | – |
| `faculty_list`, `faculty_invite` | – | – | `tpo.faculty {facultyId?}` | – |
| `notifications_list` | `notifications` | `notifications` | `notifications` | `notifications` |
| `get_my_profile`, `notifications_mark_read`, `announce` | none | none | none | none |

`resume_tailor_for_job` `data`: `{ resumeId, jobId, jobSource, credentialId, provider, model, patches: Patch[], missingKeywordsFound: string[], totalPatches, requiresManualJD?: boolean, message?: string }`
(`Patch` exactly as RESUME-BYOK / Matchy: `{id, section, targetContext, lineRange:{startLine,endLine}, charRange:{startChar,endChar}, originalSubstring, replacementSubstring, keywordsAdded, reasoning}`).

## 11. Notification type → `ui` (what `notify()` callers store)

| type | recipient | `ui` |
|---|---|---|
| `attendance.scheduled`, `attendance.rescheduled`, `attendance.cancelled`, `attendance.reminder` | student | `{panel:"schedule"}` |
| same | teacher | `{panel:"teacher.schedule", params:{sessionId}}` |
| `attendance.live` | student | `{panel:"attendance.scan"}` |
| `attendance.marked`, `attendance.low` | student | `{panel:"attendance.student", params:{courseId}}` |
| `placement.drive.new` | student | `{panel:"jobs.detail", params:{jobId, source:"campus"}}` |
| `placement.drive.pending` (company draft awaiting approval) | tpo | `{panel:"tpo.drives", params:{jobId}}` |
| `placement.application.status` | student | `{panel:"applications", params:{applicationId}}` |
| `placement.application.new` | company / tpo | `{panel:"company.applicants" or "tpo.applicants", params:{jobId, applicationId}}` |
| `placement.offer.new`, `placement.offer.updated` | student | `{panel:"offers", params:{offerId}}` |
| same | tpo | `{panel:"tpo.offers", params:{offerId}}` |
| `training.new` | student | `{panel:"training", params:{programId}}` |
| `jobfeed.matches` | student | `{panel:"jobs.market", params:{sort:"match", highlightIds:[≤10 ids]}}` (JOB-FEED.md §9.1) |
| `jobfeed.sync.failed` | tpo / admin | `{panel:"tpo.job-feed", params:{runId}}` (JOB-FEED.md §9.2; `tpo.jobfeed` is accepted, §3.8) |
| `faculty.joined` | tpo | `{panel:"tpo.faculty", params:{facultyId}}` |
| `system` | any | omit `ui` (click just marks read) |

## 12. Acceptance tests (`frontend/test/workspace.*.test.js`, `node --test`, owner shell)

1. Registry integrity: every panel id named in AGENT-TOOLS.md §5 and in this file exists; every alias target
   exists and is directly allowed for that role; every workspace panel's mode is in `ROLE_MODES[role]` for each
   of its roles; `PANELS_BY_ROLE` deep-equals §4.
2. Student + `{id:"a1", panel:"resume.lab", params:{tab:"tailor", resumeId:"r1", jobId:"j1", junk:1}}` (copilot,
   requestId "q1") → `activeMode:"resume"`, `activeResumeTool:"tailor"`, `panelParams["resume.lab"]` equals
   `{tab:"tailor", resumeId:"r1", jobId:"j1"}`, `panelNonce["resume.lab"] === 1`.
3. Same action applied again for request "q1" → skipped `DUPLICATE`; for request "q2" → applied (nonce 2).
4. Student + `tpo.offers` → skipped `FORBIDDEN`, state unchanged. TPO + `offers` → `activeMode:"tpo"`,
   `activeFeature:"offer-management"`, `activePanel:"tpo.offers"`.
5. Teacher + `schedule {days: "3"}` → `teacher.schedule`, params `{view:"list"}` (`days` not declared there → dropped).
6. `jobs.detail` without `jobId` → `MISSING_PARAM`; `{jobId:"x y"}` → `MISSING_PARAM` (invalid id dropped).
7. `notifications {tab:"preferences"}` → `overlay:"notifications"`, `activeMode` unchanged; a following
   `student.home` closes the overlay.
8. Batch `[schedule, attendance.scan]` → `activePanel:"attendance.scan"`, both panels' params stored.
9. `data` stored for `resume.lab`; a later `resume.lab` action without `data` deletes it.
10. `openPanel("jobs.market")` after `setParams({query:"react"})` keeps `{query:"react"}`; a copilot action
    without params replaces them with `{}`; `{q:"sql", highlightIds:"a1,b2,bad id"}` sanitizes to
    `{query:"sql", highlightIds:["a1","b2"]}`; `{panel:"tpo.jobfeed", params:{runId:"r9"}}` for a TPO lands on
    `tpo.job-feed` with `{runId:"r9"}`.
11. Header routing: `mode:jobparser:jobslist` with `data:[]` → no action; with `[job]` → student lands on
    `jobs.matched`; a TPO stays where they were.
12. `parsePanelUrl("?panel=teacher.live&params=%7B%22sessionId%22%3A%22s1%22%7D&nid=n1")` →
    `{panel:"teacher.live", params:{sessionId:"s1"}, nid:"n1"}`; `params=%7Bbad` → params `{}`;
    `buildPanelUrl` round-trips.
