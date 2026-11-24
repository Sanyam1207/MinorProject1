# Contract — Agent tool calling (Copilot ↔ Node tools ↔ UI)

The left-side chat is backed by the Python agent service. Specialised agents (resume generator,
interviewer, job creator, eligibility, PR outreach, alumni, gap analysis, learning) keep their own
flows. Everything else — and every request about attendance, applications, offers, notifications,
the job feed, resume scoring/tailoring — goes to the **Copilot agent**, a tool-calling agent whose
tools execute inside the Node backend **as the logged-in user**. Each tool result can carry a UI
action that updates the right-hand workspace immediately.

```
Browser ──query──▶ Node socket ──query + meta_data.{actor,tool_token,tools_url}──▶ Python orchestrator
                                                                                   │ route → copilot
                                         ┌──────── GET  /api/v1/agent-tools/manifest ◀┤
                                         │         POST /api/v1/agent-tools/execute ◀──┤ (per tool call)
                                         ▼                                             │
                               module tool handlers (attendance, placements, …)        │
Browser ◀── response {header_message: copilot:*, data:{tool_calls, ui_actions}} ◀──────┘
        └─ uiActions.applyUiActions() switches/updates the right panel
```

## 1. Tool token (Node → Python → Node)
- `backend/src/websocket/ai-query-handler.js` adds to EVERY query's `meta_data`:
  - `actor: { user_id, role, name, email }` (role is the effective role; `null` when anonymous)
  - `tool_token`: JWT HS256 signed with `AGENT_TOOL_SECRET`, claims `{ sub: userId, role, rid: requestId, sid: sessionId, typ: "agent-tool" }`, `expiresIn: "15m"`. Absent for anonymous sockets.
  - `tools_url`: `${INTERNAL_API_URL}/api/v1/agent-tools` (default `INTERNAL_API_URL=http://127.0.0.1:${PORT}`)
  - `now`: ISO timestamp and `timezone`: `APP_TIMEZONE`
- The `/agent-tools/*` routes accept ONLY this token type (`Authorization: Bearer <tool_token>`, `typ` must be `agent-tool`). They re-load the user from MongoDB on every call, so role changes apply immediately. Normal access tokens are rejected there, and tool tokens are rejected everywhere else.

## 2. Tool definition (Node, one `tools.js` per module)
```js
// backend/src/modules/<module>/tools.js
export default [
  {
    name: "attendance_schedule_class",          // ^[a-z][a-z0-9_]{2,63}$ unique across modules
    description: "Schedule a class for one of the teacher's courses …",  // written for the LLM
    roles: ["teacher"],                         // who may see/execute it
    confirm: true,                              // side effects → requires explicit user approval
    parameters: {                               // JSON-schema subset: object/string/number/integer/boolean/array/enum, required, description
      type: "object",
      properties: {
        course: { type: "string", description: "Course id, code or name, e.g. 'CS301' or 'dbms'" },
        when: { type: "string", description: "Start time, natural language or ISO, e.g. 'tomorrow 10am'" },
        durationMinutes: { type: "integer", description: "Default 60" },
        room: { type: "string" }, topic: { type: "string" },
      },
      required: ["course", "when"],
    },
    // optional: produce the confirmation text WITHOUT side effects (resolve names, parse dates, detect conflicts)
    preview: async (args, ctx) => ({ summary: "Schedule CS301 · Tue 25 Nov, 10:00–11:00 · LT-2?", args /* normalised */ }),
    handler: async (args, ctx) => ({ summary: "Scheduled CS301 for Tue 25 Nov 10:00. 58 students notified.",
                                     data: { session }, ui: { panel: "teacher.schedule", params: { sessionId } } }),
  },
];
```
`ctx = { user /* mongoose User doc */, role, requestId, sessionId, now: Date, timezone }`.
Handlers reuse the module's services (never duplicate business rules) and throw `ApiError` for user errors
(`ApiError(404, "No course matches 'dbms'", [{code:"NOT_FOUND"}])`). A handler may return
`{ ambiguous: true, message, candidates: [{id, label}] }` to make the copilot ask the user to choose.

## 3. HTTP API (`backend/src/modules/agent-tools/`, mounted at `/api/v1/agent-tools`)
- `GET /manifest` → `{ role, tools: [{ name, description, parameters, confirm }] }` — only tools whose `roles` include the caller's role.
- `POST /execute` body `{ tool, args, confirmed?: boolean }`:
  - unknown tool / role not allowed → `200 {ok:false, error:"UNKNOWN_TOOL"|"FORBIDDEN", message}`
  - args fail validation → `200 {ok:false, error:"VALIDATION", message, details}` (coerce numeric strings, drop unknown keys)
  - `confirm:true` and `confirmed !== true` → run `preview` (or a generic preview) → `200 {ok:false, needs_confirmation:true, tool, args /* normalised */, preview: "…"}`
  - success → `200 {ok:true, tool, summary, data, ui /* object | array | undefined */}`
  - handler `ApiError` → `200 {ok:false, error: errors[0]?.code || "ERROR", message}`; ambiguous → `200 {ok:false, error:"AMBIGUOUS", message, candidates}`; unexpected → `200 {ok:false, error:"INTERNAL", message:"Tool failed"}` (logged server-side).
  Tool failures are data for the LLM, so they are 200s; only auth failures are 401.
- Every execution is appended to `AgentToolCall` (`agent_tool_calls`, TTL 30 days): `{user, role, tool, args, ok, error, durationMs, requestId, sessionId, confirmed}` — an audit trail visible to admins via `GET /api/v1/agent-tools/audit` (tpo/admin, normal JWT).
- `confirmed:true` is ONLY ever sent by the copilot's own code after the human pressed "Confirm"; it is never an LLM-controlled argument.

## 4. Common tools (module `agent-tools/common.tools.js`)
- `open_panel` (all roles) `{panel: enum (role's panels from UI-ACTIONS), params?: object}` → `{summary:"Opened …", ui:{panel, params}}`
- `get_my_profile` (all) → profile summary (name, role, branch, passingYear, cgpa, skills, resume count, attendance overall for students)
- `notifications_list` / `notifications_mark_read` (all) — implemented in the notifications module.

## 5. Tool catalogue (implemented by each module; names are fixed)
| module | tool | roles | confirm |
|---|---|---|---|
| attendance | `attendance_list_courses` | teacher, student, tpo, admin | – |
| attendance | `attendance_create_course` | teacher | ✓ |
| attendance | `attendance_list_sessions` `{course?, from?, to?, status?}` | teacher, student, tpo, admin | – |
| attendance | `attendance_schedule_class` `{course, when, durationMinutes?, room?, topic?}` | teacher | ✓ |
| attendance | `attendance_auto_schedule_class` `{course, durationMinutes?, within?: "this week"|"next 3 days"…, preferredDays?, topic?}` | teacher | ✓ |
| attendance | `attendance_reschedule_class` `{session?, course?, from?, when, durationMinutes?}` | teacher | ✓ |
| attendance | `attendance_cancel_class` `{session?, course?, when?, reason?}` | teacher | ✓ |
| attendance | `attendance_start_session` `{session?, course?}` → ui `teacher.live` | teacher | ✓ |
| attendance | `attendance_end_session` `{session?}` | teacher | ✓ |
| attendance | `attendance_session_report` `{session?, course?, date?}` → ui `teacher.report` | teacher, tpo, admin | – |
| attendance | `attendance_course_report` `{course, threshold?}` → ui `teacher.analytics` | teacher, tpo, admin | – |
| attendance | `attendance_notify_defaulters` `{course, threshold?, message?}` | teacher | ✓ |
| attendance | `attendance_mark_manual` `{session?, student, status, note?}` | teacher | ✓ |
| attendance | `attendance_my_summary` → ui `attendance.student` | student | – |
| attendance | `attendance_my_schedule` `{days?}` → ui `schedule` | student, teacher | – |
| attendance | `attendance_join_course` `{joinCode}` | student | ✓ |
| attendance | `attendance_open_scanner` → ui `attendance.scan` | student | – |
| placements | `jobs_search_campus` `{query?, location?, minPackageLpa?, eligibleOnly?, limit?}` → ui `jobs.campus` | student, tpo, admin, company | – |
| placements | `job_details` `{job}` → ui `jobs.detail` | all | – |
| placements | `drive_apply` `{job, resumeId?, coverNote?}` → ui `applications` | student | ✓ |
| placements | `applications_list` `{status?}` → ui `applications` | student | – |
| placements | `application_withdraw` `{application?, job?}` | student | ✓ |
| placements | `offers_list` → ui `offers` (student) / `tpo.offers` | student, tpo, admin | – |
| placements | `offer_respond` `{offer?, job?, decision: "accept"|"reject", reason?}` | student | ✓ |
| placements | `training_list` `{mine?}` → ui `training` | student, tpo, admin | – |
| placements | `training_register` `{program}` | student | ✓ |
| placements | `drives_list` `{status?}` → ui `tpo.drives` / `company.drives` | tpo, admin, company | – |
| placements | `drive_create` `{title, company, description, salary?, location?, deadline, minCgpa?, maxBacklogs?, branches?, graduationYears?, skills?, employmentType?}` | tpo, admin, company | ✓ |
| placements | `drive_close` `{job}` | tpo, admin, company | ✓ |
| placements | `applicants_list` `{job, status?}` → ui `tpo.applicants` | tpo, admin, company | – |
| placements | `application_update_status` `{application, status, note?}` | tpo, admin, company | ✓ |
| placements | `offer_create` `{application, ctc, role?, joiningDate?, expiresAt?}` | tpo, admin, company | ✓ |
| placements | `placement_stats` → ui `tpo.analytics` | tpo, admin | – |
| placements | `announce` `{title, body, audience: {roles?, branch?, passingYear?}}` | tpo, admin | ✓ |
| job-feed | `jobs_search_market` `{query?, category?, jobType?, source?, limit?}` → ui `jobs.market` | all | – |
| job-feed | `market_job_save` `{job}` / `market_job_mark_applied` `{job}` → ui `jobs.tracker` | student | – |
| job-feed | `job_feed_sync` | tpo, admin | ✓ |
| resume-lab | `resume_list` → ui `resume.lab` | student | – |
| resume-lab | `resume_score` `{resume?}` → ui `resume.lab` `{tab:"ats"}` | student | – |
| byok | `resume_tailor_for_job` `{job, resume?, credentialId?}` → ui `resume.lab` `{tab:"tailor", resumeId, jobId}` (+ `data.patches`) | student | – |
| faculty | `faculty_list` / `faculty_invite` `{name, email, department?}` (✓) | tpo, admin | – / ✓ |

Fuzzy references (`course`, `job`, `session`, `application`, `offer`, `program`, `resume`, `student`): accept an id,
or a free-text label that the module resolves (code/name/title/company/email; sessions also by `when`/date).

## 6. Copilot agent (Python, `ai-service/app/agents/copilot/`)
- Registered as mode `copilot` (`AgentMode.COPILOT`). The orchestrator routes to it when its ROUTING_RULES win, when no other agent matches (replaces the old `mode:none` dead end — no "switching you to…" line in that case), and while the UI keeps `mode_name: "copilot"`.
- LLM: Gemini function calling over REST (`GEMINI_API_KEY`, `COPILOT_MODEL` default = `GEMINI_MODEL`). The manifest is converted to `tools:[{functionDeclarations:[…]}]`. Max 6 tool rounds per turn; parallel function calls in one round are executed sequentially in order.
- Without a key, or if the LLM call fails, a deterministic planner maps the message to tools (regex intents + argument extraction) and composes the answer from tool `summary` fields — the product stays usable offline.
- Confirmation: when `/execute` answers `needs_confirmation`, the copilot stores `{tool, args, preview}` in its per-session store (TTL 10 min) and ends the turn with `copilot:confirm` + `options: ["Confirm", "Cancel"]`. On the next turn an affirmative reply ("confirm", "yes", "go ahead", "do it", "ok") re-executes with `confirmed:true`; a negative reply cancels; anything else drops the pending action and is handled as a new request.

### Wire format (chunks emitted by the copilot; `response` is ALWAYS the full markdown so far)
| header_message | isEnd | data |
|---|---|---|
| `copilot:thinking` | false | `{type:"copilot", phase:"thinking", tool_calls:[...], ui_actions:[...]}` |
| `copilot:tool` | false | same shape; `tool_calls[i] = {id, name, args, status:"running"|"done"|"error"|"needs_confirmation", summary?, error?}` |
| `copilot:answer` | true | same shape, `phase:"answer"`; optional `options` (suggested follow-ups) |
| `copilot:confirm` | true | same shape plus `pending:{tool, args, preview}`; `options:["Confirm","Cancel"]` |
| `copilot:error` | true | `{type:"copilot", phase:"error", message}` |
`ui_actions` is cumulative for the request: `[{id, panel, params, data?}]`; the frontend applies each id once, in order, as soon as it appears.
