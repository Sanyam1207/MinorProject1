# Contract — Campus Placements (drives, applications, eligibility, offers & policy, training, recruiters, analytics, interviews)

Owner module: `backend/src/modules/placements/`. It owns `/api/v1/jobs` (plus the alias `/api/v1/drives`),
`/api/v1/applications`, `/api/v1/offers` (including `/offers/policy`), `/api/v1/training` and `/api/v1/placements`.
It also adds `GET /api/v1/interviews/my` and `GET /api/v1/interviews/:id` to the existing
`backend/src/routes/interview.routes.js`.

Every route uses `requireAuth` from `core/http.js` (that is `verifyJWT`). Responses go through `send()` / `fail()`:
- success: `{statusCode, data, message, success:true}`
- error: `{success:false, message, errors:[{code, ...}], data:null}`

Below, **→** means "the value of `data`".

This contract builds on:
- `NOTIFICATIONS.md`: `notify()`
- `AGENT-TOOLS.md`: §2 for the tool shape and §5 for the catalogue
- the core seams: `core/http.js`, `core/realtime.js`, `core/scheduler.js`, `core/mailer.js` and `core/rate-limit.js`

Routes and tools never return raw Mongoose documents. Every response is built by `services/views.js` (§5).

---

## 0. Files

### 0.1 Create
```
backend/src/modules/placements/
  index.js                     module export (§0.4)
  config.js                    env parsing (§13)
  constants.js                 enums, labels, transition table
  models/application.model.js            model Application            collection applications
  models/offer.model.js                  model Offer                  collection offers
  models/placement-policy.model.js       model PlacementPolicy        collection placement_policies
  models/training-program.model.js       model TrainingProgram        collection training_programs
  models/training-enrollment.model.js    model TrainingEnrollment     collection training_enrollments
  services/academic-year.js  services/package.js  services/branches.js  services/skills.js   (pure helpers, §2;
                                    branches.js wraps the shared utils/branch.js#canonicalBranch from AUTH-FACULTY §6.3)
  services/eligibility.service.js   the single source of truth for eligibility (§4)
  services/scope.js                 role, college and company filters (§1)
  services/views.js                 every response shape (§5)
  services/drive.service.js         drive CRUD, review/publish, AI upsert, agent metadata (§6.1, §8)
  services/application.service.js  apply, withdraw, pipeline, bulk, export (§6.2, §7.2)
  services/offer.service.js         offer lifecycle (§7.3)
  services/policy.service.js        resolve, save, classify (§3.4, §7.3)
  services/training.service.js  services/stats.service.js  services/announce.service.js
  services/events.js                ALL notify() and socket calls (§9, §10); exports setNotifier(fn) for tests
  services/resolve.js               fuzzy references for the agent tools (§12.1)
  services/locks.js                 withLock(key, fn): in-process per-key promise mutex
  services/migrate.js               runPlacementMigrations() (§3.8)
  services/sweep.js                 runSweep() (§11)
  routes/jobs.routes.js  routes/applications.routes.js  routes/offers.routes.js
  routes/training.routes.js  routes/placements.routes.js
  utils/dates.js  utils/csv.js  utils/input.js
  tools.js                          agent tools (§12)
backend/test/placements/helpers.js and backend/test/placements/*.test.js;  backend/test/interviews.test.js   (§16)
```

### 0.2 Modify
| file | change |
|---|---|
| `backend/src/models/job.models.js` | Extend the schema, remove the embedded `applications`, and replace the session-unique index (§3.1). |
| `backend/src/models/user.models.js` | Add `activeBacklogs`, `tenthPercentage` and `twelfthPercentage` (§3.7). The change is additive next to AUTH-FACULTY's own User changes. |
| `backend/src/services/user-profile.service.js` (created by AUTH-FACULTY) | Add three student-only rows to `buildProfileUpdate` (§3.7). |
| `backend/src/websocket/job-service.js` | Becomes a thin adapter over `drive.service.js`. The export names stay the same (§8). |
| `backend/src/websocket/ai-query-handler.js` | `persistJobCreationResponse` also passes `draftId: payload.data?.draft_id` to `persistConfirmedJob` (§8). |
| `backend/src/websocket/metadata-builder.js` | Both `getEligibilityJobs()` calls become `getEligibilityJobs(user)`. Add one rule to `ELIGIBILITY_CONTRACT.rules` (§8). |
| `backend/src/websocket/auth-context.js` | `buildProfile` prefers stored academic fields over client `details` (§8). |
| `backend/src/routes/interview.routes.js` | Add `GET /my` and `GET /:id` (§6.6). |
| `backend/src/services/interview.service.js` | `listStudentInterviews(ownerId, limit, {includeRaw})` (§6.6). |
| `backend/package.json` | Set `"test": "node --test --test-concurrency=1 \"test/**/*.test.js\""`. Add the devDependency `mongodb-memory-server@^10` (§16). |

### 0.3 Delete
`backend/src/controllers/job.controller.js` and `backend/src/routes/job.routes.js`. They are the legacy public `GET /jobs`, which is no longer mounted and leaked embedded applications.

### 0.4 Module export
```js
// backend/src/modules/placements/index.js
export default {
  name: "placements",
  routers: [
    { path: "/api/v1/jobs", router: jobsRouter },
    { path: "/api/v1/drives", router: jobsRouter },        // alias: the SAME router instance
    { path: "/api/v1/applications", router: applicationsRouter },
    { path: "/api/v1/offers", router: offersRouter },
    { path: "/api/v1/training", router: trainingRouter },
    { path: "/api/v1/placements", router: placementsRouter },
  ],
  async start() {
    await runPlacementMigrations();                         // §3.8; idempotent; runs before server.listen
    registerJob("placements.sweep", config.sweepIntervalMs, runSweep, { runOnStart: true });
  },
  tools,                                                    // ./tools.js (§12)
};
```

**Out of scope:**
- external and aggregated jobs (the job-feed module)
- resume storage, compile and tailoring (resume-lab and byok)
- notification delivery (notifications)
- the copilot runtime (agent-tools and ai-service)
- QR attendance for training sessions (attendance)

---

## 1. Roles and scope

**Terms:**
- **staff** = `tpo` or `admin`
- **recruiter** = `company`
- `requireRole()` always lets `admin` through.

`services/scope.js` defines these filters:

- **`collegeScope(user)`**
  - admin → `{}`. When an admin passes `?collegeId=`, use `{college: collegeId}` instead.
  - user with a `college` → `{college: {$in: [user.college, null]}}`. Records with `college: null` are global or legacy, so every college sees them.
  - otherwise → `{college: null}`.
- **`companyScope(user)`** → `{company: user.company, ...collegeScope(user)}`. Throws `403 COMPANY_NOT_LINKED` if `user.company` is empty.
- **`jobScope(user, {appliedJobIds})`**
  - tpo / admin → `collegeScope`
  - company → `companyScope`
  - student → `collegeScope` AND `{$or: [{status:"active"}, {_id: {$in: appliedJobIds}, status:"closed"}]}`, where `appliedJobIds = Application.distinct("job", {student})`
  - teacher / alumni → `collegeScope` AND `{status:"active"}`
- **`applicationScope(user)`** and **`offerScope(user)`**
  - student → `{student: user._id}`
  - tpo / admin → `collegeScope`
  - company → `companyScope`
  - teacher / alumni → `403 FORBIDDEN`

A record outside the caller's scope answers **`404 NOT_FOUND`**, never 403, so ids do not leak.

| capability | student | teacher / alumni | company | tpo / admin |
|---|---|---|---|---|
| list / view drives | `active`, plus `closed` drives they applied to | `active` | own company's drives, any status | all statuses |
| create drive | – | – | yes → `pending` | yes → `active` (or `draft`) |
| edit drive | – | – | own drives while `draft` / `pending` / `rejected` | yes |
| publish / reject drive | – | – | – | yes |
| close drive | – | – | own | yes |
| delete drive (only if it has no applications) | – | – | own, while not `active` / `closed` | yes |
| apply / withdraw | yes | – | – | – |
| applicants, status change, bulk, CSV | – | – | own company's drives (cannot reopen `rejected`) | yes |
| add an applicant on a student's behalf | – | – | – | yes |
| create / edit / revoke offer | – | – | on own company's applications | yes (also off-campus offers) |
| accept / reject / withdraw offer | own offers | – | – | – |
| place / override offer | – | – | – | yes |
| read policy | yes | yes | yes | yes |
| write policy | – | – | – | yes |
| training: list | programs whose audience matches them | all | – | all |
| training: register | yes | – | – | – |
| training: manage | – | – | – | yes |
| stats, announcements | – | – | – | yes |

Recruiter (`company`) accounts are provisioned by AUTH-FACULTY §7.3 (`/api/v1/recruiters`). Each account has `company` (a Company id) and `college` (the inviting college). This module only reads those two fields.

---

## 2. Shared rules

### 2.1 Error codes (`errors[0].code`)
| code | status | when |
|---|---|---|
| `VALIDATION` | 400 | Bad input. `errors[0].field` names the field. |
| `DEADLINE_IN_PAST` | 400 | Creating a drive with `applicationDeadline <= now`. |
| `NO_RECIPIENTS` / `TOO_MANY_RECIPIENTS` | 400 | Announcements (§6.5). |
| `FORBIDDEN` | 403 | The role is not allowed. |
| `COMPANY_NOT_LINKED` | 403 | A recruiter whose `user.company` is empty. |
| `NOT_ELIGIBLE` | 403 | An academic criterion failed. Carries `errors[0].reasons[]`. |
| `POLICY_BLOCKED` | 403 | The one-offer policy blocks the apply. Carries `reasons[]`, `currentAcceptedPackage` and `requiredPackageLpa`. |
| `NOT_FOUND` | 404 | Missing, or outside the caller's scope. |
| `RESUME_NOT_FOUND` | 404 | `resumeId` is not an active resume of the student, or the application has no resume attached. |
| `NOT_REGISTERED` | 404 | Unregistering from training without a registration. |
| `DRIVE_NOT_OPEN` | 409 | Applying to a drive whose status ≠ `active`. |
| `DEADLINE_PASSED` | 409 | Applying, or publishing or reopening a drive, after `applicationDeadline`. |
| `ALREADY_APPLIED` | 409 | An application already exists and is not `withdrawn`. Also returned for the duplicate-key race. |
| `INVALID_TRANSITION` | 409 | The status change is not allowed from the current state. |
| `USE_OFFER_FLOW` | 409 | Setting `offered` / `hired` directly, or changing an `offered` / `hired` application outside the offer flow. |
| `OFFER_PENDING` | 409 | Withdrawing an application that has an `extended` offer. |
| `OFFER_EXISTS` | 409 | Creating an offer while one is `extended` / `accepted` / `placed` for the same application. |
| `OFFER_NOT_PENDING` | 409 | Accepting or rejecting an offer that is not `extended`. |
| `ONE_OFFER_POLICY` | 409 | Accepting is blocked by the policy. Carries `currentAcceptedPackage` and `requiredPackageLpa`. |
| `MAX_PENDING_OFFERS` | 409 | The student already holds `maxPendingOffers` `extended` offers. |
| `HAS_APPLICATIONS` / `HAS_ENROLLMENTS` | 409 | A delete is blocked. |
| `PROGRAM_CLOSED` / `REGISTRATION_CLOSED` / `PROGRAM_FULL` / `ALREADY_REGISTERED` | 409 | Training (§7.5). |
| `OFFER_EXPIRED` | 410 | Accepting or rejecting after `expiresAt`. The offer is first flipped to `expired`. |
| `PROFILE_INCOMPLETE` | 422 | Eligibility needs profile data. Carries `errors[0].missing: ["cgpa", ...]`. |
| `TOO_MANY_ATTEMPTS` | 429 | Raised by `core/rate-limit.js`. |
| `DUPLICATE` | 409 | Raised by `app.js` on an unexpected E11000. |

### 2.2 Time (`utils/dates.js`)
- **Storage and clock.** Times are stored in UTC. The college zone is `APP_TIMEZONE` (default `Asia/Kolkata`). `clock.now()` wraps `new Date()`, and tests call `setClock(() => fixedDate)`. Every service reads "now" from `clock.now()`.
- **`parseDateInput(value, {endOfDay = false, field})`:**
  - A `Date`, or an ISO string with a time (`/T\d{2}:\d{2}/`) → that instant.
  - `YYYY-MM-DD` → that day in `APP_TIMEZONE`: 00:00:00.000 by default, or 23:59:59.999 when `endOfDay` (luxon `startOf("day")` / `endOf("day")`).
  - Any other text → chrono-node with `forwardDate: true`, reference instant `clock.now()` and the `APP_TIMEZONE` offset. If the parse has no certain hour (`!start.isCertain("hour")`), apply the day rule above.
  - Unparseable → `400 VALIDATION {field}`.
- **Which rule each field uses:** `applicationDeadline` and offer `expiresAt` use `endOfDay`. `driveDate` and training dates use start of day.
- **Display helpers:** `formatDay(d)` → `"5 Dec"` and `formatDateTime(d)` → `"5 Dec 2026, 23:59"`, both in `APP_TIMEZONE`. Notifications, CSV and tool summaries use them.

### 2.3 Academic year (`services/academic-year.js`)
- **`academicYearFor(date)`:**
  1. `local` = `date` in `APP_TIMEZONE`.
  2. `start = local.month >= ACADEMIC_YEAR_START_MONTH ? local.year : local.year - 1`.
  3. Return `` `${start}-${String((start + 1) % 100).padStart(2,"0")}` ``, e.g. `"2026-27"`.
- **`academicYearRange("2026-27")`** → `{start: 2026-07-01T00:00, end: 2027-07-01T00:00}` in local time. `end` is exclusive.
- **`isValidAcademicYear(s)`** is true when `s` matches `/^(\d{4})-(\d{2})$/` and the second part = (first + 1) % 100.

### 2.4 Package (`services/package.js`, pure)
`parsePackageLpa(input) → {min, max}`. Values are LPA rounded to 2 decimals, or `null`.

1. `null` / `""` / `undefined` → nulls. A number `n`:
   - `n >= 10000` → rupees per annum, so `n / 100000`.
   - `0 < n <= 500` → already LPA.
   - anything else → nulls.
2. For a string: lowercase it and drop `₹`, `rs.`, `rs`, `inr` and `,`. If it matches `not disclosed|n/?a|tbd|confidential` or has no digits → nulls.
3. Take the first number, plus a second one if they are joined by `-`, `–` or `to`. Apply the first matching unit:

   | unit | conversion |
   |---|---|
   | `cr` / `crore` | ×100 |
   | `lpa` / `lakh(s)` / `lac(s)` / a bare `l` | ×1 |
   | `k` / `thousand` | ÷100 |
   | none | `v >= 10000 ? v/100000 : v` |

4. Monthly amounts (`per month`, `/month`, `/mo`, `pm`, `p.m.`, `monthly`) → ×12.
5. Values ≤ 0 or > 500 → nulls. A single value gives `max = min`.

| input | result (min / max) |
|---|---|
| `"18 LPA"` | 18 / 18 |
| `"12-15 LPA"` | 12 / 15 |
| `"12 to 15 lakhs"` | 12 / 15 |
| `"₹18,00,000"` | 18 / 18 |
| `"1.2 Cr"` | 120 / 120 |
| `"INR 6.5 lakhs"` | 6.5 / 6.5 |
| `"50k per month"` | 6 / 6 |
| `"25000/month"` | 3 / 3 |
| `18` | 18 / 18 |
| `1800000` | 18 / 18 |
| `"not disclosed"` | null |
| `"competitive"` | null |

**Formatting:**
- `formatLpa(n)` = `String(Number(n.toFixed(2)))`.
- `packageLabel(job)`:
  - When `packageLpa == null`: the trimmed `salary` if it is non-empty and not "not disclosed"; otherwise `"Not disclosed"`.
  - Otherwise: `"12–15 LPA"` when `packageMaxLpa > packageLpa`, else `"18 LPA"`.

### 2.5 Branches (`services/branches.js`)
There is **one** branch canonicaliser in the product: `canonicalBranch(value)` in `backend/src/utils/branch.js`, owned by AUTH-FACULTY §6.3.
- It returns `AIML`, `AIDS`, `CSE`, `IT`, `ECE`, `EEE`, `EE`, `ME` or `CE`, or the original trimmed value (cut to 60 characters).
- Student `branch` values are already stored canonicalised when they are written.
- This module must not define its own alias table. If more branches are needed (MAE, IIoT, A&R, …), add rules to that util.

`services/branches.js` only wraps it:
- **`normalizeText(s)`:** lowercase; `&` → ` and `; replace non-`[a-z0-9]` with a space; collapse spaces.
- **`isUnrestricted(list)`** is true when `list` is empty, or when any entry normalizes to `all`, `any`, `all branches`, `all streams` or `open to all`.
- **`branchMatches(studentBranch, allowed)`:** true if `isUnrestricted(allowed)`; otherwise true when some entry `a` gives `normalizeText(canonicalBranch(a)) === normalizeText(canonicalBranch(studentBranch))`. Job `eligibleBranches` are stored as entered, so both sides are canonicalised at compare time.
- **`branchLabel(s)`** = `canonicalBranch(s)` or `"Unspecified"` when empty. Stats use it for grouping.

### 2.6 Skills (`services/skills.js`)
- **`canonSkill(s)`:** lowercase, keep only `[a-z0-9+#]`, and when the length is > 4 and it ends in `js`, drop the `js`. So `Node.js` → `node`, `React.js` → `react`, and `C++` is kept as is.
- **Student skills** = `user.skills` ∪ `user.projects[].skills`.
- **`skillMatch(studentSkills, jobSkills)`:**
  - A job with no skills → `{matchPercentage: null, matchedSkills: [], missingSkills: []}`.
  - Otherwise, dedupe the job skills by canon and set `matchPercentage = round(100 × matched / total)`. Both arrays keep the job's spelling.

### 2.7 Input helpers (`utils/input.js`)
- `str(v, {max, required, field})` trims.
- `num(v, {min, max, int, field})` accepts numeric strings; `""` and NaN become `undefined`.
- `list(v, {maxItems, maxLen, field})` accepts an array or a comma-separated string; it trims, drops empties and dedupes case-insensitively.
- `bool(v)` accepts `true`, `"true"` and `1`.
- `objectId(v, field)` uses `assertObjectId`.
- Unknown body keys are ignored everywhere.

---

## 3. Models

**Conventions:**
- Register models with `mongoose.models.X || mongoose.model("X", schema, "<collection>")`.
- Mongoose 9: pre-hooks are plain or async functions and get **no `next`**.
- Use `returnDocument: "after"`, not `new: true`.
- Timestamps are on for every model.

### 3.1 Job — extend `backend/src/models/job.models.js`
The model stays `Job` and the collection stays `jobs`. The job-feed module must use a different model name and collection.

| field | type | notes |
|---|---|---|
| title | String, required, trim, maxlength 300 | kept |
| description | String, required, maxlength 20000 | kept |
| company | ObjectId→Company, required | kept. Find-or-create by case-insensitive exact name (`escapeRegex`). |
| companyLogo | String | kept. Must be an `https` URL. |
| salary | String, default `"not disclosed"`, maxlength 100 | kept. The display text as entered. |
| **packageLpa** | Number, min 0, max 500, default null | NEW. Lower bound from `parsePackageLpa(packageLpa ?? salary)`. |
| **packageMaxLpa** | Number, default null | NEW. Upper bound; equals `packageLpa` for a single value. |
| eligibleBranches | [String] | kept. Stored as entered and matched through §2.5. |
| location | String, default "" | kept |
| employmentType | String, default "", maxlength 60 | kept |
| minimumCgpa | Number, min 0, max 10 | kept |
| maximumBacklogs | Number, min 0, max 50 | kept (integer) |
| **min10thPercentage** / **min12thPercentage** | Number, min 0, max 100 | NEW |
| graduationYears | [String] | kept. Four-digit years. |
| skills | [String] | kept |
| selectionProcess | String, default "" | kept |
| **rounds** | [{name: String required ≤120, at: Date, venue: String ≤200, mode: enum `online`\|`offline` default offline, notes: String ≤500}] | NEW, at most 10 |
| applicationDeadline | Date | kept. Required for new drives; the service validates it, not the schema, so legacy documents still load. |
| **driveDate** | Date, default null | NEW |
| status | enum `draft`\|`pending`\|`active`\|`closed`\|`rejected`, default `active`, index | EXTENDED. Added `pending` and `rejected`. |
| **college** | ObjectId→College, default null, index | NEW. Set from the creator's `college`; an admin may pass `collegeId`. |
| createdBy | ObjectId→User | kept |
| **createdByRole** | enum `tpo`\|`admin`\|`company`, default `tpo` | NEW |
| sourceSessionId | String | kept. The AI job-creator chat session. |
| **sourceDraftKey** | String | NEW. AI job-creator idempotency key (§8). |
| **review** | {decision: enum `approved`\|`rejected`, by: ObjectId→User, byName: String, at: Date, note: String ≤500} | NEW |
| **publishedAt** / **closedAt** | Date, default null | NEW |
| **closedReason** | enum `manual`\|`deadline`, default null | NEW |
| **notifiedAt** | Date, default **null** | NEW. Set atomically when the `drive.new` fan-out runs. |
| **deadlineReminderSentAt** | Date, default null | NEW |

**Removed:** the `applications` path and `ApplicationSchema`. Existing data is migrated (§3.8) and never written again.

**Indexes:**
- REMOVE `{createdBy:1, sourceSessionId:1}` unique. §3.8 drops it from the database.
- ADD `{createdBy:1, sourceSessionId:1, sourceDraftKey:1}` unique, with `partialFilterExpression: {createdBy:{$type:"objectId"}, sourceSessionId:{$type:"string"}, sourceDraftKey:{$type:"string"}}`.
- ADD `{college:1, status:1, applicationDeadline:1}`, `{company:1, status:1}` and `{status:1, applicationDeadline:1}`.

### 3.2 Application (`applications`) — replaces the embedded `Job.applications`
| field | type | notes |
|---|---|---|
| job | ObjectId→Job, required | |
| student | ObjectId→User, required, index | |
| college | ObjectId→College, default null, index | `job.college ?? student.college` |
| company | ObjectId→Company, required, index | `job.company`; used for the recruiter scope |
| academicYear | String, required | `academicYearFor(appliedAt)` |
| status | enum `applied`\|`shortlisted`\|`interview`\|`offered`\|`hired`\|`rejected`\|`withdrawn`, default `applied`, index | §7.2 |
| timeline | [{status, at: Date, by: ObjectId→User\|null, byRole: String, byName: String, note: String ≤500}] | The first entry is `applied`. **Notes are visible to the student.** |
| resume | {id: ObjectId→Resume, title: String, version: Number} \| null | An active resume-bank `Resume` owned by the student |
| coverNote | String ≤2000, default "" | |
| eligibilitySnapshot | {eligible: Boolean\|null, status: enum `eligible`\|`ineligible`\|`incomplete`\|`override`\|`unknown`, code, reasons: [String], missing: [String], checks: [Check], policy: {…§4}, profile: {cgpa, activeBacklogs, branch, passingYear, tenthPercentage, twelfthPercentage, verified: Boolean}, evaluatedAt: Date} | Computed on the server from the **stored User** at apply time. The request body is never used. `verified` = `user.ggsipuLinked`. |
| eligibilityOverride | {by, byName, at, note} \| null | Set when staff add an applicant despite eligibility (§6.2) |
| source | enum `web`\|`agent`\|`tpo`\|`migrated`, default `web` | |
| offer | ObjectId→Offer \| null | The latest offer |
| appliedAt | Date, default now | Reset when the student re-applies |
| withdrawnAt / decidedAt | Date \| null | `decidedAt` = the time it became `rejected` or `hired` |

**Indexes:** `{job:1, student:1}` **unique**; `{student:1, appliedAt:-1}`; `{job:1, status:1}`; `{college:1, academicYear:1, status:1}`; `{company:1, status:1}`.

**Pre-validate hook** (async, no `next`). It keeps seeds and migrations simple:
- missing `academicYear` → `academicYearFor(appliedAt ?? now)`
- missing `company` or `college` → loaded from `Job.findById(job).select("company college")`
- missing `timeline` → `[{status, at: appliedAt, byRole:"system"}]`

`eligibilitySnapshot` and `resume` are optional. The AUTH-FACULTY demo seed relies on that.

### 3.3 Offer (`offers`)
Field names follow `StudentOffers.jsx` and `OfferManagement.jsx`.

| field | type | notes |
|---|---|---|
| student | ObjectId→User, required, index | |
| application | ObjectId→Application \| null, index | |
| job | ObjectId→Job \| null | |
| company | ObjectId→Company \| null, index | |
| college | ObjectId→College \| null, index | |
| companyName | String, required, ≤200 | Denormalized; the UI reads it |
| roleTitle | String, required, ≤200 | Defaults to `job.title` |
| packageLpa | Number, required, >0, ≤500 | |
| ctcText | String ≤100 | The original text when the CTC was given as text |
| offerType | enum `normal`\|`dream`\|`super-dream`, default `normal` | §7.3 |
| status | enum `extended`\|`accepted`\|`rejected`\|`withdrawn`\|`expired`\|`placed`, default `extended`, index | |
| expiresAt | Date, required | Defaults to the end of the day `now + policy.offerExpiryDays` |
| joiningDate | Date \| null | |
| location | String ≤200 | |
| offerLetterUrl | String, `https` only, ≤500 | |
| academicYear | String, required, index | `academicYearFor(createdAt)` |
| statusHistory | [{status, changedAt, by, byRole, byName, note}] | The UI reads `status`, `changedAt` and `note` |
| tpoOverride | Boolean, default false | |
| responseReason | String ≤500 | The student's reject or withdraw reason |
| respondedAt / placedAt / reminderSentAt | Date \| null | |
| createdBy / createdByRole | ObjectId→User / String | |

**Indexes:** `{student:1, status:1}`, `{college:1, academicYear:1, status:1}`, `{company:1, status:1}`, `{status:1, expiresAt:1}`.

**Pre-validate hook:**
- missing `academicYear` → `academicYearFor(createdAt ?? now)`
- empty `statusHistory` → `[{status, changedAt: now, byRole:"system"}]`

### 3.4 PlacementPolicy (`placement_policies`)
Field names follow `PolicyConfigPanel.jsx`.

| field | type / default | validation |
|---|---|---|
| college | ObjectId→College \| null | `null` = the global default policy (admin) |
| academicYear | String, required | `isValidAcademicYear` |
| enforceOneOffer | Boolean, true | |
| allowDreamUpgrade | Boolean, true | |
| dreamMultiplier | Number, 1.5 | 1.1–5 |
| superDreamMultiplier | Number, 2.0 | 1.5–10, and ≥ dreamMultiplier |
| maxPendingOffers | Number, 3 | integer 1–10 |
| offerExpiryDays | Number, 7 | integer 1–30 |
| isActive | Boolean, true | At most one active policy per college; saving one deactivates the others |
| updatedBy | ObjectId→User | |

**Index:** `{college:1, academicYear:1}` unique.

**`DEFAULT_POLICY`** = `{enforceOneOffer:true, allowDreamUpgrade:true, dreamMultiplier:1.5, superDreamMultiplier:2.0, maxPendingOffers:3, offerExpiryDays:7}`. This matches `defaultPolicy()` in `PolicyConfigPanel.jsx`.

**`resolvePolicy(collegeId, academicYear)`** returns the first match:
1. `{college, academicYear}`
2. the college's `isActive` policy, latest `updatedAt`
3. `{college:null, academicYear}`
4. the global `isActive` policy
5. `DEFAULT_POLICY` with `{_id:null, academicYear, isDefault:true}`

### 3.5 TrainingProgram (`training_programs`)
Field names follow `TrainingHub.jsx` and `TrainingScheduler.jsx`.

| field | type | notes |
|---|---|---|
| college | ObjectId→College \| null, index | |
| title | String, required, ≤200 | |
| description | String ≤5000, default "" | |
| type | enum `aptitude`\|`technical`\|`soft-skills`\|`certification`\|`workshop`\|`mock-interview`\|`other`, default `other` | Rendered as-is in a badge |
| instructor | String ≤120, default "" | |
| deliveryMode | enum `online`\|`offline`\|`hybrid`, default `offline` | |
| capacity | Number, integer, required, min **1** | So the scheduler's `enrolledCount/capacity` never divides by zero |
| enrolledCount | Number, default 0 | Kept in step atomically (§7.5) |
| status | enum `upcoming`\|`ongoing`\|`completed`\|`cancelled`, default `upcoming` | Always a string, because the UI calls `.toUpperCase()` |
| schedule | [{date: Date required, time: String ≤40 (`HH:mm` or `HH:mm-HH:mm`, default ""), venue: String ≤200 (default `"TBA"`), topic: String ≤200, durationMinutes: Number 15–600}] | **Validator: length ≥ 1 (and ≤ 60).** A pre-validate hook sorts it ascending by `date`, so `schedule[0]` is always the first session. |
| registrationDeadline | Date \| null | |
| audience | {branches: [String], graduationYears: [String], minCgpa: Number\|null} | Empty means everyone |
| cancelReason | String ≤500 | |
| createdBy | ObjectId→User | |

**Index:** `{college:1, status:1, "schedule.date":1}`.

### 3.6 TrainingEnrollment (`training_enrollments`)
AUTH-FACULTY's demo seed expects the model name `TrainingEnrollment`. The student-facing action is still called "register" (`POST /training/:id/register`).

| field | type | notes |
|---|---|---|
| program | ObjectId→TrainingProgram, required, index | |
| student | ObjectId→User, required, index | |
| status | enum `registered`\|`cancelled`, default `registered` | |
| completionStatus | enum `enrolled`\|`in-progress`\|`completed`\|`dropped`, default `enrolled` | `TrainingHub` shows the CERTIFICATE button only for `completed` |
| attendance | [{sessionIndex: Number, date: Date, markedAt: Date, markedBy: ObjectId→User, method: enum `manual`\|`qr`}] | The UI shows `attendance.length / schedule.length` |
| certificateUrl | String (https) \| null | |
| registeredAt | Date | |

**Index:** `{program:1, student:1}` unique.

### 3.7 User additions (`backend/src/models/user.models.js`)
`activeBacklogs: {type: Number, min: 0, max: 50}`, `tenthPercentage: {type: Number, min: 0, max: 100}`, `twelfthPercentage: {type: Number, min: 0, max: 100}`.

**Profile editing.** Add three rows to AUTH-FACULTY §6.1 `buildProfileUpdate` (`backend/src/services/user-profile.service.js`):
- The rows are student-only and are **not** GGSIPU-locked.
- `activeBacklogs` must be an integer 0–50; `tenthPercentage` and `twelfthPercentage` must be numbers 0–100.
- Numeric strings are accepted, and `null` clears the field.
- An invalid value → `400 VALIDATION {field}`.

`GET /auth/me` returns the three fields as part of the user, and `toProfileSummary` may include them. The demo seed sets `activeBacklogs` (AUTH-FACULTY §16.2).

### 3.8 Boot migration (`services/migrate.js#runPlacementMigrations`)
Runs on every boot and is idempotent. Each step has its own try/catch and logs on failure.

1. Run `Job.collection.dropIndex("createdBy_1_sourceSessionId_1")`, ignoring "index not found" (code 27) and "ns not found" (code 26). Then `await Job.createIndexes()`.
2. Set `status: "active"` where `status` is missing or `null`.
3. Convert the legacy embedded `applications`. Read them through `Job.collection`, because the path is no longer in the schema.
   - Each entry's `student` is a `Student` id. Map it with `User.findOne({student})`.
   - Upsert (`$setOnInsert`) an Application:
     - `status`: `applied` → `applied`, `inprogress` → `shortlisted`, `rejected` → `rejected`; skip the others
     - `source: "migrated"`
     - `eligibilitySnapshot: {eligible:null, status:"unknown", reasons:["Migrated from the legacy job record"]}`
     - one timeline entry with `byRole:"system"` and `byName:"Migration"`
   - Then run `Job.collection.updateMany({applications:{$exists:true}}, {$unset:{applications:""}})`.
4. Backfill fields. Use `$exists:false` filters only.

   | field | backfilled with | applies to |
   |---|---|---|
   | `createdByRole` | the creator's role (default `tpo`) | all jobs |
   | `college` | the creator's `college` (else `null`) | all jobs |
   | `packageLpa` / `packageMaxLpa` | `parsePackageLpa(salary)` | all jobs |
   | `publishedAt` | `createdAt` | `active` and `closed` jobs |
   | `notifiedAt` | `createdAt` | all jobs, so legacy drives are never re-announced |
   | `sourceDraftKey` | the fingerprint (§8) | jobs whose `sourceSessionId` is a string |

   New documents always store `notifiedAt: null` through the schema default, so this step never touches them.

---

## 4. Eligibility service (single source of truth)

`services/eligibility.service.js` is the **only** code that decides eligibility. These callers use it:
- `GET /jobs`, `GET /drives/matched`, `GET /jobs/:id` and `GET /jobs/:id/eligibility`
- apply, and staff adding an applicant
- the recipients of the `drive.new` and deadline-reminder notifications
- the agent metadata (`getEligibilityJobs`, §8)
- every agent tool

The Python job-eligibility agent should report the server verdict instead of computing its own (§15).

```js
studentFacts(user) → { cgpa, activeBacklogs, branch, passingYear, tenthPercentage, twelfthPercentage, verified: Boolean(user.ggsipuLinked) }
//   read only from the stored User document (GGSIPU sync or the profile), never from the request body
loadPolicyContext(studentId, collegeId) → { policy /* resolvePolicy(collegeId, academicYearFor(now)) */,
                                            held: { offerId, companyName, packageLpa } | null }
//   held = the student's accepted/placed offer with the highest packageLpa, in any academic year
evaluateEligibility({ facts, job, policyContext }) → Eligibility           // pure and synchronous
evaluateForJobs(user, jobs) → Map<jobId, Eligibility>                      // one policy context per distinct college
findEligibleStudentIds(job, { excludeApplied = false }) → [userId]         // active students in the job's college scope with status "eligible"
```

**Checks.** A check runs only when the job sets that criterion. This mirrors `ai-service/app/agents/job_eligibility/rules_engine.py`.

| key | runs when | passes when | missing field |
|---|---|---|---|
| `cgpa` | `minimumCgpa != null` | `cgpa >= minimumCgpa` | `cgpa` |
| `backlogs` | `maximumBacklogs != null` | `activeBacklogs <= maximumBacklogs` | `activeBacklogs` |
| `branch` | `!isUnrestricted(eligibleBranches)` | `branchMatches(branch, eligibleBranches)` | `branch` |
| `graduationYear` | `graduationYears.length > 0` | `graduationYears.includes(String(parseInt(passingYear, 10)))` | `passingYear` |
| `tenth` / `twelfth` | `min10thPercentage` / `min12thPercentage` set | percentage ≥ minimum | `tenthPercentage` / `twelfthPercentage` |
| `policy.oneOffer` | `policy.enforceOneOffer && held` | `policy.allowDreamUpgrade && job.packageLpa != null && job.packageLpa >= requiredPackageLpa` | – |

- `requiredPackageLpa = round2(held.packageLpa × policy.dreamMultiplier)`.
- When the student value is null or undefined, the check gets `passed: null`.
- Each check is `{key, label, required, actual, passed}`. Example: `{key:"cgpa", label:"Minimum CGPA", required:">= 7.50", actual:"6.80", passed:false}`.

```
Eligibility = {
  eligible: boolean,                       // status === "eligible"
  status: "eligible" | "ineligible" | "incomplete",
  code: "ELIGIBLE" | "NOT_ELIGIBLE" | "POLICY_BLOCKED" | "PROFILE_INCOMPLETE",
  reasons: string[],                       // failed-check sentences (academic first), or the incomplete sentence
  missing: string[],                       // profile fields to fill
  checks: Check[],
  policy: { enforced, blocked, currentAcceptedPackage /* held.packageLpa|null */, requiredPackageLpa, isDreamUpgrade }
}
```

**Status precedence:**
1. Any academic check is `false` → `ineligible` with `NOT_ELIGIBLE`.
2. Otherwise, the policy check is `false` → `ineligible` with `POLICY_BLOCKED`.
3. Otherwise, any check is `null` → `incomplete` with `PROFILE_INCOMPLETE`.
4. Otherwise → `eligible`. `isDreamUpgrade` is true when the policy check ran and passed.

**Reason sentences** (exact templates):

| case | sentence |
|---|---|
| CGPA | `Your CGPA of 6.80 is below the required minimum of 7.50.` |
| backlogs | `You have 2 active backlog(s); at most 0 allowed.` |
| branch | `Your branch (Mechanical Engineering) is not among the eligible branches: CSE, IT.` |
| graduation year | `This drive is open to 2026 graduates; your passing year is 2027.` |
| 10th / 12th | `Your 12th percentage (72%) is below the 75% cut-off.` |
| policy, dream upgrades off | `One-offer policy: you have already accepted Infosys (6 LPA), so you cannot apply to new drives.` |
| policy, package unknown | `One-offer policy: you have already accepted Infosys (6 LPA). This drive's package is not disclosed, so it cannot count as a dream upgrade.` |
| policy, below the threshold | `One-offer policy: you have already accepted Infosys (6 LPA). Only drives offering at least 9 LPA are open to you.` |
| incomplete | `Add your CGPA and active backlogs to your profile to check eligibility.` (labels joined with ", " and a final " and ") |

---

## 5. Response views (`services/views.js`)
- Ids are strings and dates are ISO strings.
- **Never output** these job fields: `applications`, `sourceSessionId`, `sourceDraftKey`, `notifiedAt`, `deadlineReminderSentAt`, `__v`.
- **Never output** another student's data in a student-facing view.

**JobView (base: every role)**
```
{ _id, title, roleTitle /* = title */, description, company: {_id, name}, companyName, companyLogo,
  salary, packageLpa, packageMaxLpa, packageLabel, location, employmentType,
  skills, skillsRequired /* = skills */, eligibleBranches, minimumCgpa, minCgpa /* = minimumCgpa */,
  maximumBacklogs, graduationYears, min10thPercentage, min12thPercentage, selectionProcess,
  rounds: [{_id, name, at, venue, mode, notes}], applicationDeadline, deadline /* = applicationDeadline */,
  driveDate, status, isOpen /* status==="active" && deadline > now */, applicationUrl: null,
  publishedAt, createdAt, updatedAt }
```
The alias fields (`roleTitle`, `companyName`, `skillsRequired`, `minCgpa` and `deadline`) keep `App.jsx`, `AdminMode.jsx` and `InterviewWorkspace.jsx` working unchanged. A job whose company document is missing gets `company = {_id:null, name:"Unknown Company"}`.

**StudentJobView** = JobView plus:
```
{ eligibility /* §4 */, isEligible /* eligibility.eligible */, eligibilityReason /* reasons[0] || "" */,
  matchPercentage, matchedSkills, missingSkills,
  myApplication: {_id, status, statusLabel, appliedAt, updatedAt} | null, applicationStatus /* myApplication?.status ?? null */,
  canApply, applyBlockedCode /* DRIVE_NOT_OPEN|DEADLINE_PASSED|ALREADY_APPLIED|NOT_ELIGIBLE|POLICY_BLOCKED|PROFILE_INCOMPLETE|null */,
  applyBlockedReason }
```
`canApply` is false in the first of these cases that applies, and `applyBlockedCode` names it:

| case | `applyBlockedCode` |
|---|---|
| status ≠ `active` | `DRIVE_NOT_OPEN` |
| deadline passed | `DEADLINE_PASSED` |
| an application exists that is not `withdrawn` | `ALREADY_APPLIED` |
| not eligible | `eligibility.code` |

**StaffJobView** (tpo, admin, company) = JobView plus:
```
{ college, createdBy: {_id, name, role} | null, createdByRole, review, closedAt, closedReason,
  applicantCount, statusCounts: {applied, shortlisted, interview, offered, hired, rejected, withdrawn} }
```
Counts come from one `Application.aggregate` per list.

**AgentJobSummary** (tool `data.jobs[]`). The key names are the first-named keys that JOB-FEED §12.5 `campus_item` reads, so the Python jobs-finder can render campus drives:
```
{ id, _id /* = id */, title, company: {_id, name}, companyName, companyLogo,
  salary /* = packageLabel */, packageLpa, packageLabel, location, employmentType, skills,
  description /* first 1200 chars */, minimumCgpa, maximumBacklogs, eligibleBranches, graduationYears, selectionProcess,
  applicationUrl: null, createdAt, applicationDeadline, driveDate, status,
  // student viewer only:
  isEligible, eligibilityReason, eligibilityReasons /* ≤3 */, matchScore /* = matchPercentage */, matchPercentage, matchedSkills,
  myApplication: {_id, status, statusLabel} | null, applicationStatus,
  // staff / company viewer only:
  applicantCount }
```

**ApplicationStudentView**
```
{ _id, status, statusLabel, appliedAt, updatedAt, withdrawnAt,
  job: {_id, title, companyName, packageLabel, location, applicationDeadline, driveDate, status},
  timeline: [{status, at, note}], resume: {id, title} | null, coverNote,
  eligibilitySnapshot: {eligible, status, reasons}, offer: {_id, status, packageLpa} | null }
```

**ApplicationStaffView**
```
{ _id, status, statusLabel, appliedAt, updatedAt, source,
  job: {_id, title, companyName},
  student: {_id, name, email, rollNumber, ggsipuEnrollment, branch, section, semester, passingYear, cgpa, activeBacklogs, skills /* ≤20 */},
  eligibilitySnapshot, eligibilityOverride, resume: {id, title} | null, coverNote,
  timeline: [{status, at, byName, byRole, note}], offer: {_id, status, packageLpa} | null }
```
For **company** viewers, strip `eligibilitySnapshot.policy` and every check or reason that comes from the `policy.oneOffer` check. Otherwise a recruiter would learn about the student's other offers.

**`statusLabel` values:**

| status | label |
|---|---|
| applied | Applied |
| shortlisted | Shortlisted |
| interview | Interview |
| offered | Offer received |
| hired | Hired |
| rejected | Not selected |
| withdrawn | Withdrawn |

**OfferStudentView.** These are exactly the fields `StudentOffers.jsx` reads, plus a few extras:
```
{ _id, status, offerType, companyName, roleTitle, packageLpa, expiresAt, joiningDate, location, offerLetterUrl,
  academicYear, tpoOverride, statusHistory: [{status, changedAt, note}],
  isDreamEligible, currentAcceptedPackage, dreamMultiplier, job: {_id, title} | null, createdAt, updatedAt }
```
These three fields are computed at read time:
- `currentAcceptedPackage` = the highest `packageLpa` among the student's **other** accepted or placed offers, or `null`.
- `dreamMultiplier` = `resolvePolicy(offer.college, offer.academicYear).dreamMultiplier`.
- `isDreamEligible` = all of: `status === "extended"`, `currentAcceptedPackage != null`, `policy.allowDreamUpgrade`, and `packageLpa >= currentAcceptedPackage × dreamMultiplier`.

**OfferStaffView** = OfferStudentView plus:
```
{ student: {_id, name, email, branch, cgpa, rollNumber, passingYear}, application, createdBy: {_id, name, role},
  createdByRole, responseReason, statusHistory: [{status, changedAt, note, byName, byRole}] }
```

**PolicyView**
```
{ _id|null, college|null, academicYear, enforceOneOffer, allowDreamUpgrade, dreamMultiplier,
  superDreamMultiplier, maxPendingOffers, offerExpiryDays, isActive, isDefault, updatedAt|null, updatedBy: {_id, name}|null }
```

**ProgramView**
```
{ _id, title, description, type, instructor, deliveryMode, capacity, enrolledCount, seatsLeft, status,
  schedule: [{_id, date, time, venue, topic, durationMinutes}], nextSession: {date, time, venue, topic} | null,
  registrationDeadline, audience, cancelReason, createdAt,
  isRegistered? /* student only */ }
```
`nextSession` is the first schedule entry dated today or later (`APP_TIMEZONE`), otherwise the last entry.

**EnrollmentView** (the shape `TrainingHub` "MY PROGRAMS" reads)
```
{ _id, program: ProgramView, completionStatus, attendance: [{sessionIndex, date, markedAt, method}], registeredAt, certificateUrl }
```

---

## 6. REST API
Every router starts with `router.use(requireAuth)`. Each path param is validated with `assertObjectId`, so a bad id gives `400 VALIDATION`. **Literal routes are declared before `/:id`.**

### 6.1 Drives — `/api/v1/jobs`, with `/api/v1/drives` as an alias (same router)
| method + path | roles | input | → `data` | errors |
|---|---|---|---|---|
| `GET /` | any | query below | **array**: `StudentJobView[]`, `StaffJobView[]` (tpo/admin/company) or `JobView[]` (teacher/alumni) | 403 COMPANY_NOT_LINKED |
| `GET /matched` | student | `limit` (default 20) | `StudentJobView[]` with `eligible` only, sorted by `matchPercentage` desc then deadline asc | |
| `POST /` | tpo, company | Drive input (below) | `201 {job: StaffJobView, notifiedStudents: number\|null}` | 400 VALIDATION / DEADLINE_IN_PAST, 403 COMPANY_NOT_LINKED |
| `GET /:id` | any (scoped) | | role view, as in `GET /` | 404 |
| `PATCH /:id` | tpo; company (own, while `draft`/`pending`/`rejected`) | partial Drive input (no `status`) | `{job}` | 403 FORBIDDEN (company editing `active`/`closed`), 400, 404 |
| `DELETE /:id` | tpo; company (own, while `draft`/`pending`/`rejected`) | | `{deleted:true}` | 409 HAS_APPLICATIONS, 404 |
| `POST /:id/publish` | tpo | `{note?}` | `{job, notifiedStudents}` | 409 INVALID_TRANSITION (already `active`), 409 DEADLINE_PASSED |
| `POST /:id/reject` | tpo | `{note}` (required, 3–500 chars) | `{job}` | 409 INVALID_TRANSITION (not `pending`) |
| `POST /:id/close` | tpo; company (own) | `{reason?}` | `{job}` | 409 INVALID_TRANSITION from `rejected`. A `closed` drive returns 200 unchanged. |
| `GET /:id/eligibility` | student (self); tpo (`?studentId=` required) | | `{jobId, studentId, eligibility, matchPercentage, matchedSkills, missingSkills}` | 404 |
| `POST /:id/apply` | student | `{resumeId?, coverNote?}` | `201 {application: ApplicationStudentView}` (`200` when a withdrawn application is re-activated) | apply errors (§7.2) |
| `GET /:id/applications` | tpo, company | query as `GET /applications` | `{items, total, page, limit, statusCounts, job: StaffJobView}` | 404 |
| `GET /:id/applications/export.csv` | tpo, company | as `GET /applications/export.csv` | CSV | 404 |

**`GET /` query parameters:**

| parameter | values and default |
|---|---|
| `status` | Staff and company: a comma list of statuses, or `all` (default `all`). Ignored for students, teachers and alumni. |
| `q` | Escaped, case-insensitive regex over `title`, `skills`, `location`, and company names. Company ids are pre-resolved by a name regex, limit 50. |
| `location` | Regex. |
| `minPackageLpa` | Number. Drives with a null `packageLpa` are excluded. |
| `eligibleOnly=true` | Students only. |
| `sort` | `deadline` \| `recent` \| `match` \| `package`. Default: `deadline` for students, `recent` for others. `deadline` puts open drives first by `applicationDeadline` asc (nulls last), then the rest by `createdAt` desc. |
| `limit` | 1–200, default 100. |
| `page` | ≥ 1. |

For students: fetch at most 500 candidates, compute eligibility, filter and sort in memory, then page.

**Drive input.** `normalizeDriveInput(body, user)` maps the `CompanyMode.jsx` field set onto the canonical names. When an alias and a canonical key are both present, the canonical key wins.

| canonical | accepted aliases (CompanyMode keys in **bold**) | rule |
|---|---|---|
| `companyName` | **`companyName`**, `company` (string) | Required for tpo/admin. **Ignored for company users**, who always post for `user.company`. Find-or-create the Company. |
| `title` | **`title`**, `roleTitle`, `job_role` | Required, 2–300 characters. |
| `description` | **`description`**, `jdText` | Required on create, ≤20000 characters. |
| `salary` / `packageLpa` | **`packageLpa`** (`"18 LPA"`, or a number), `salary`, `ctc` | `{min,max} = parsePackageLpa(packageLpa ?? salary)`. Store `salary` = the original text (or `packageLabel` when only a number was given). |
| `applicationDeadline` | **`deadline`**, `applicationDeadline`, `app_deadline` | `parseDateInput(…, {endOfDay:true})`. If missing but `driveDate` is given, default to the end of the day before `driveDate`. If both are missing → 400 VALIDATION. On create, it must be > now (`400 DEADLINE_IN_PAST`). |
| `driveDate` | **`driveDate`** | Start of day. Must be on or after the deadline's day, else `400 VALIDATION {field:"driveDate"}`. |
| `minimumCgpa` | **`minCgpa`**, `minimumCgpa`, `minimum_cgpa` | 0–10. `""` / NaN → unset. |
| `maximumBacklogs` | `maxBacklogs`, `maximumBacklogs`, `maximum_backlogs` | Integer 0–50. |
| `eligibleBranches` | **`eligibleBranch`** (array), `eligibleBranches`, `branches` | `list`, ≤30 items, each ≤100 characters. |
| `skills` | **`skillsRequired`**, `skills` | `list`, ≤50 items, each ≤60 characters. |
| `location` | **`location`** | ≤200 characters. |
| `graduationYears` | `graduationYears`, `graduation_years` | Four-digit years from 2000 to 2100, stored as strings, ≤10. |
| `employmentType`, `selectionProcess`, `rounds`, `min10thPercentage`, `min12thPercentage`, `companyLogo` | the same names | As in §3.1. |
| `status` | `status` | tpo/admin may send `draft` or `active` (default `active`). Ignored for company users. |
| `collegeId` | `collegeId` | Admin only. Otherwise `college = user.college`. |

**Status on create:**
- **company** → `pending`, plus `events.driveSubmitted` (`placement.drive.pending`) to the TPOs. When `PLACEMENT_COMPANY_AUTO_APPROVE=true`, the drive is published immediately instead.
- **tpo/admin** with `active` → publish (§7.1). `notifiedStudents` = the number of recipients queued.
- **tpo/admin** with `draft` → `notifiedStudents: null`.

A company `PATCH` on a `rejected` drive moves it back to `pending` and notifies the TPOs again. A staff `PATCH` on an `active` drive does not re-notify students. Existing eligibility snapshots are never recomputed.

### 6.2 Applications — `/api/v1/applications`
| method + path | roles | input | → `data` | errors |
|---|---|---|---|---|
| `GET /my` | student | `status?` | `ApplicationStudentView[]`, sorted `appliedAt` desc | |
| `GET /export.csv` | tpo, company | `jobId?, status?, branch?, passingYear?, q?` | `text/csv` (below) | 404 when `jobId` is out of scope |
| `POST /bulk-status` | tpo, company | `{applicationIds: string[1..500], status, note?}` | `{updated, unchanged, failed: [{id, code, message}]}` | 400 VALIDATION |
| `GET /` | tpo, company | query below | `{items: ApplicationStaffView[], total, page, limit, statusCounts}` | |
| `POST /` | tpo | `{jobId, studentId, note?, overrideEligibility?, resumeId?}` | `201 {application: ApplicationStaffView}` | eligibility errors unless overridden; 409 ALREADY_APPLIED; 404 |
| `GET /:id` | owner student, or scoped staff/company | | the matching view | 404 |
| `PATCH /:id/status` | tpo, company | `{status, note?}` | `{application: ApplicationStaffView, changed: boolean}` | 409 INVALID_TRANSITION / USE_OFFER_FLOW |
| `POST /:id/withdraw` | owner student | `{reason?}` | `{application: ApplicationStudentView}` | 409 OFFER_PENDING / INVALID_TRANSITION |
| `GET /:id/resume` | owner student, or scoped staff/company | | `{url, expiresAt}` from `buildPrivateResumeUrl()` in `services/resume-bank.service.js` | 404 RESUME_NOT_FOUND; 503 when Cloudinary is not configured |

**`GET /` query parameters:**

| parameter | values and default |
|---|---|
| `jobId` | |
| `status` | A comma list. |
| `branch` | Matched with `branchMatches`. |
| `passingYear` | |
| `q` | Student name / email / roll number / enrollment (regex). |
| `eligible` | `true` \| `false`, matched against `eligibilitySnapshot.eligible`. |
| `sort` | `recent` (default, `appliedAt` desc) \| `cgpa` (desc) \| `name` \| `status` (pipeline order). |
| `page` | ≥ 1. |
| `limit` | 1–200, default 50. |

`statusCounts` ignores the `status` filter.

**Staff add (`POST /`).** The student must be a `student` in the TPO's college. The job must be in scope with status `active` or `closed`. The service runs eligibility:
- When the result is not `eligible` and `overrideEligibility !== true` → the matching 403/422 error.
- When overriding, `note` must be 3–500 characters. The application gets `eligibilitySnapshot.status = "override"`, `eligibilityOverride` and `source:"tpo"`.

The student is notified (`placement.application.status`, title `Added to {Company} – {Title}`).

**CSV export** (`utils/csv.js#toCsv(columns, rows)`):
- **Headers:** `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="applicants-<slug company>-<slug title>-<YYYY-MM-DD>.csv"`. Without `jobId` the filename is `applicants-<date>.csv`.
- **Body:** a UTF-8 BOM, then rows joined by `\r\n`, at most 10 000 rows.
- **Escaping:** a cell that starts with `=`, `+`, `-`, `@`, tab or CR gets a `'` prefix (formula injection guard). A cell containing `"`, `,`, CR or LF is quoted, with inner quotes doubled.
- **Columns:** `Application ID, Student Name, Email, Roll Number, Enrollment, Branch, Section, Passing Year, CGPA, Active Backlogs, Eligible At Apply (Yes|No|Incomplete|Override|Unknown), Eligibility Notes (reasons joined "; "), Status, Applied At, Last Updated, Company, Role, Resume, Offer Status, Offer Package (LPA)`.
- **Values:** dates use `formatDateTime`. Company viewers never see policy reasons in the notes.

### 6.3 Offers and policy — `/api/v1/offers` (`/my` and `/policy` are declared before `/:id`)
| method + path | roles | input | → `data` | errors |
|---|---|---|---|---|
| `GET /my` | student | | **array** `OfferStudentView[]` (`StudentOffers.jsx` reads `res.data`). Order: `extended` by `expiresAt` asc, then `accepted`/`placed`, then the rest by `updatedAt` desc. Due offers are expired lazily first. | |
| `GET /policy` | any | `academicYear?` | **PolicyView itself**, not wrapped. `PolicyConfigPanel.jsx` calls `setPolicy(res.data)` and falls back to `defaultPolicy()` only when it is falsy. The value is `resolvePolicy(user.college, academicYear ?? academicYearFor(now))` (§3.4), so with nothing saved it is the defaults with `isDefault:true`. | 400 VALIDATION (bad year) |
| `POST /policy`, `PUT /policy` | tpo | the full panel object; `_id`, `isDefault` and other unknown keys are ignored | PolicyView | 400 VALIDATION `{field}` |
| `GET /` | tpo, company | `status?` (one, a comma list, or `all`), `academicYear?`, `q?`, `jobId?`, `page?`, `limit?` (≤500, default 200) | **`{offers: OfferStaffView[], total, statusCounts}`** (`OfferManagement.jsx` reads `res.data.offers` and `res.data.total`) | |
| `POST /` | tpo, company | Offer input (below) | `201 {offer: OfferStaffView}` | 400, 404, 409 OFFER_EXISTS / INVALID_TRANSITION / MAX_PENDING_OFFERS |
| `GET /:id` | owner student, or scoped staff | | the matching view | 404 |
| `PATCH /:id` | tpo, company (scoped); `extended` offers only | `{packageLpa?, roleTitle?, expiresAt?, joiningDate?, location?, offerLetterUrl?, note?}` | `{offer}` | 409 INVALID_TRANSITION |
| `POST /:id/accept` | owner student | | `{offer: OfferStudentView, released: [{_id, companyName, packageLpa}]}` | 409 OFFER_NOT_PENDING / ONE_OFFER_POLICY, 410 OFFER_EXPIRED |
| `POST /:id/reject` | owner student | `{reason?}` | `{offer}` | 409 OFFER_NOT_PENDING, 410 |
| `POST /:id/withdraw` | owner student | `{reason?}` | `{offer}` | 409 INVALID_TRANSITION (only from `accepted`) |
| `POST /:id/place` | tpo | | `{offer}` | 409 INVALID_TRANSITION (only from `accepted`) |
| `POST /:id/override` | tpo | `{newStatus, note}` (`newStatus` in the enum and ≠ current; `note` 3–500 characters) | `{offer}` | 400, 409 |
| `POST /:id/revoke` | tpo, company (scoped) | `{reason}` (3–500 characters) | `{offer}` | 409 INVALID_TRANSITION (only from `extended`/`accepted`) |

**Offer input.** The CTC is given as `packageLpa` (a number) or `ctc` (a number or text, through `parsePackageLpa`, using `min`). It must resolve to a value in (0, 500].
- **Fields:**
  - `applicationId`: required for company users.
  - `studentId` with `jobId`, or `studentId` with `companyName` and `roleTitle`: staff-only off-campus or PPO offers.
  - `roleTitle?` defaults to `job.title`.
  - `expiresAt?` defaults to the end of the day `now + offerExpiryDays`.
  - Also: `joiningDate?`, `location?`, `offerLetterUrl?`, `note?`.
- **With an application:** it must be in scope and in `applied`, `shortlisted` or `interview`. Anything else → `409 INVALID_TRANSITION`. If a live offer exists → `409 OFFER_EXISTS`.
- **Policy check:** `count(student's extended offers) >= policy.maxPendingOffers` → `409 MAX_PENDING_OFFERS`.

**Policy save** (`POST /policy`):
1. Validate as in §3.4.
2. Upsert `{college: user.college (admin: body.collegeId ?? null), academicYear}`.
3. Set `isActive:true` and `updatedBy`.
4. `updateMany` the college's other policies to `isActive:false`.

### 6.4 Training — `/api/v1/training` (`/my` is declared before `/:id`)
| method + path | roles | input | → `data` | errors |
|---|---|---|---|---|
| `GET /` | any | `status?` (comma list or `all`; default `upcoming,ongoing`), `q?`, `type?` | **array** `ProgramView[]`, sorted by `schedule[0].date` asc. Students see only programs whose `audience` matches them (§7.5). | |
| `GET /my` | student | | **array** `EnrollmentView[]`, only `status:"registered"` | |
| `POST /` | tpo | `{title, description?, type?, instructor?, deliveryMode?, capacity, schedule:[{date, time?, venue?, topic?, durationMinutes?}], registrationDeadline?, audience?}` | `201 ProgramView` | 400 VALIDATION (empty schedule, capacity < 1, …) |
| `GET /:id` | any (scoped) | | ProgramView (+ `myRegistration` for students) | 404 |
| `PATCH /:id` | tpo | the same fields, partial | ProgramView | 400, 404 |
| `POST /:id/cancel` | tpo | `{reason?}` | ProgramView (`cancelled`) | 409 INVALID_TRANSITION (`completed`/`cancelled`) |
| `DELETE /:id` | tpo | | `{deleted:true}` | 409 HAS_ENROLLMENTS |
| `POST /:id/register` | student | | `201 {enrollment: EnrollmentView}` (`200` when re-activated) | 403 NOT_ELIGIBLE (audience), 409 PROGRAM_CLOSED / REGISTRATION_CLOSED / PROGRAM_FULL / ALREADY_REGISTERED |
| `DELETE /:id/register` | student | | `{enrollment}` (`cancelled`, `enrolledCount` −1) | 404 NOT_REGISTERED, 409 PROGRAM_CLOSED (once started) |
| `GET /:id/enrollments` | tpo | | `{program: ProgramView, enrollments: [{_id, student: {_id,name,email,branch,passingYear,rollNumber}, completionStatus, attendance, registeredAt, certificateUrl}]}` | |
| `POST /:id/attendance` | tpo | `{sessionIndex, studentIds: [...], present: boolean}` | `{updated}` | 400 (index out of range) |
| `PATCH /:id/enrollments/:enrollmentId` | tpo | `{completionStatus?, certificateUrl?}` | `{enrollment}` | 400, 404 |

### 6.5 Placements — `/api/v1/placements`
| method + path | roles | input | → `data` |
|---|---|---|---|
| `GET /me` | any | | `{role, college: {_id, name, domain} \| null, company: {_id, name} \| null, academicYear}`. `GET /auth/me` returns `company` as a bare id, so CompanyMode uses this to show the recruiter's company. |
| `GET /stats` | tpo | `academicYear?` (default current), `passingYear?`, `branch?`, `collegeId?` (admin) | Stats (below) |
| `POST /announcements` | tpo | `{title (≤140), body (≤1000), audience: {roles?: [student\|teacher\|alumni\|company\|tpo] (default [student]), branch?: string\|string[], passingYear?: string\|string[]}, email?: boolean (default true)}`. Rate limit: 5 per minute. | `{recipients}` (400 NO_RECIPIENTS / TOO_MANY_RECIPIENTS) |

Recruiter accounts (list, invite, deactivate) are **not** here. They live at `/api/v1/recruiters` (AUTH-FACULTY §7.3).

**Stats** (`services/stats.service.js`):
```
{ academicYear, generatedAt, filters: {passingYear, branch, collegeId},
  totals: { students, placedStudents, placedPercent, unplacedStudents, applications, offers,
            drives: {draft, pending, active, closed, rejected, total} },
  packages: { count, avgLpa, medianLpa, maxLpa, minLpa },
  offersByStatus: { extended, accepted, rejected, withdrawn, expired, placed },
  applicationsByStatus: { applied, shortlisted, interview, offered, hired, rejected, withdrawn },
  byBranch: [{ branch, students, placedStudents, placedPercent, avgLpa, medianLpa, maxLpa }],   // students desc
  topCompanies: [{ companyId, companyName, offers, accepted, avgLpa, maxLpa }],                // ≤10
  monthly: [{ month: "2026-07", offers, accepted }] }                                          // the 12 months of the academic year
```
**Definitions:**
- **Population:** active students (`role:"student"`, `isActive != false`) in the college scope, filtered by `passingYear` (exact string) and `branch` (`branchLabel` equal) when given.
- **placedStudents:** population members with an offer in `{accepted, placed}` whose `academicYear` equals the requested year.
- **placedPercent:** `round1(100 × placed / students)`, or `null` when `students = 0`.
- **packages:** computed over each placed student's **best** accepted or placed package in the year, so a student is never counted twice. The median is the middle value, or the mean of the two middle values. Every value is null when `count = 0`.
- **offers, offersByStatus, topCompanies, monthly:** offers of population students in the year.
- **topCompanies:** grouped by `company ?? lowercase(companyName)`. `accepted` counts `accepted` + `placed`. `avgLpa` is over accepted or placed offers. `maxLpa` is over all offers. Sorted by `accepted` desc, then `offers` desc, then `maxLpa` desc.
- **applicationsByStatus:** applications of population students with the year's `academicYear`.
- **drives:** jobs in scope with `createdAt` inside `academicYearRange`.
- **Rounding:** LPA values to 2 decimals and percentages to 1 decimal.

### 6.6 Interviews — add to `backend/src/routes/interview.routes.js` (declare `/my` before `/:id`)
- **`GET /my`** (student; other roles → `fail(403, "Student account required", "FORBIDDEN")`) → `listStudentInterviews(user._id, req.query.limit, {includeRaw:true})`.
  - The result is an **array**, because `LearningRecommendationWorkspace.jsx` reads `res.data` as an array.
  - The select also includes `candidateName` and, with `includeRaw`, `rawReport`, which the UI prefers for `selected_interview`.
  - Each item keeps `interviewId`.
  - `GET /` stays as it is.
- **`GET /:id`** (any role, **owner only**):
  - `assertObjectId` → 400 VALIDATION.
  - `getInterviewById(user._id, id)`; null → `fail(404, "Interview not found", "NOT_FOUND")`.
  - → the full interview document plus `interviewId`.

---

## 7. Lifecycle rules

### 7.1 Drive lifecycle
`draft` →(publish)→ `active`; `pending` →(publish | reject)→ `active` | `rejected`; `rejected` →(company edit)→ `pending`; `active` →(close | deadline sweep)→ `closed`; `closed` →(publish, only if the deadline is still in the future)→ `active`.

**Publishing** (`drive.service#publish`):
1. Set `status:"active"`, set `publishedAt` if it is unset, and set `review = {decision:"approved", …}` when the drive came from `pending`/`rejected`.
2. Call `events.drivePublished(job)`. It claims the fan-out with `Job.updateOne({_id, notifiedAt:null}, {$set:{notifiedAt:now}})` and continues only if `modifiedCount === 1`.
3. Compute the recipients with `findEligibleStudentIds(job)`. Return their count synchronously and send `notify()` in the background (`setImmediate`, batches of 500, errors logged).
4. Recruiters of a company-created drive get `placement.drive.status`.

A drive is announced at most once, even if it is re-published.

### 7.2 Application pipeline
**Apply** (`POST /jobs/:id/apply`, tool `drive_apply`). The steps run in order inside `withLock("apply:"+student+":"+job)`:
1. The job is in scope, else 404.
2. `status === "active"`, else `409 DRIVE_NOT_OPEN`.
3. `applicationDeadline > now`, else `409 DEADLINE_PASSED`.
4. Check for an existing application:
   - status `withdrawn` → re-activate (go on to the next steps; the end result is a 200 with the same `_id`);
   - any other status → `409 ALREADY_APPLIED`. For `rejected`, the message is "Your earlier application to this drive was not selected".
5. Eligibility (§4): `incomplete` → `422 PROFILE_INCOMPLETE {missing}`; `NOT_ELIGIBLE` → `403 {reasons}`; `POLICY_BLOCKED` → `403 {reasons, currentAcceptedPackage, requiredPackageLpa}`.
6. Resume:
   - `resumeId` given → it must be `Resume.findOne({_id, owner: student, status:"active"})`, else `404 RESUME_NOT_FOUND`;
   - not given → attach the student's latest active resume-bank resume (`version` desc), if any.
7. Insert, or update the withdrawn document with `{status:"applied", appliedAt:now, timeline: push applied, eligibilitySnapshot, resume, coverNote}`. A duplicate-key error → `409 ALREADY_APPLIED`.
8. Emit `placement:application` to the student and `placement:applicants` to staff (§10). Send `placement.application.new` to the drive company's recruiters (§9). **No notification** goes to the student for their own action.

**Staff status changes** (`PATCH /:id/status`, bulk, tool `application_update_status`). Staff may set only `applied`, `shortlisted`, `interview` or `rejected`:

| from \ to | applied | shortlisted | interview | rejected |
|---|---|---|---|---|
| applied | – | ✓ | ✓ | ✓ |
| shortlisted | ✓ | – | ✓ | ✓ |
| interview | ✓ | ✓ | – | ✓ |
| rejected | tpo/admin only | tpo/admin only | tpo/admin only | – |

**Disallowed changes:**
- **Target `offered` or `hired`**, or a source of `offered` or `hired` → `409 USE_OFFER_FLOW`, with the message "Create or change the offer instead (POST /offers or offer_create)".
- **Source `withdrawn`** → `409 INVALID_TRANSITION`.
- **A company user reopening `rejected`** → `409 INVALID_TRANSITION`.

**Each change:**
- Same status → `{changed:false}`, no write and no notification.
- A change pushes a timeline entry `{status, at, by, byRole, byName, note}` and sets `decidedAt` for `rejected`.
- It notifies the student (`placement.application.status`) and emits socket events.

**Bulk:** each id is processed independently and the result is partial. Ids outside scope go into `failed` with `NOT_FOUND`.

**Student withdraw:**
- from `applied`, `shortlisted` or `interview` → `withdrawn` (`withdrawnAt`, timeline note = the reason);
- from `offered` → `409 OFFER_PENDING` ("Reject the offer instead");
- from `hired`, `rejected` or `withdrawn` → `409 INVALID_TRANSITION`.

Re-applying is allowed while the drive is open (step 4 above).

### 7.3 Offer lifecycle and placement policy
| action | actor | from → to | side effects |
|---|---|---|---|
| create | tpo/admin/company | – → `extended` | `offerType` set (below); application → `offered`, `application.offer` set; notify the student `placement.offer.new` |
| edit (`PATCH`) | creator scope | `extended` → `extended` | `offerType` recomputed; history note "Offer updated"; notify the student |
| accept | owner student | `extended` → `accepted` | algorithm below |
| reject | owner student | `extended` → `rejected` | application → `withdrawn` ("Offer declined"); notify staff |
| withdraw | owner student | `accepted` → `withdrawn` | application → `withdrawn`; notify staff |
| place | tpo/admin | `accepted` → `placed` | `placedAt`; notify the student "You are officially placed at {Company}" |
| revoke | tpo/admin/company scope | `extended`\|`accepted` → `withdrawn` | application → `rejected` ("Offer revoked"); notify the student |
| override | tpo/admin | any → any other status | `tpoOverride:true`; history note `TPO override: {note}`; **the policy is not enforced**; the application is synced (§7.4); override to `extended` with `expiresAt <= now` resets `expiresAt` to now + `offerExpiryDays`; notify the student |
| expire | sweep, or lazily on read/accept/reject | `extended` with `expiresAt <= now` → `expired` | history note "Expired without a response"; application → `withdrawn`; notify the student and staff |

Every transition updates with a status-guarded filter, for example `{_id, status:"extended"}`. A null result → `409 OFFER_NOT_PENDING` or `409 INVALID_TRANSITION`.

**Accept.** The steps run inside `withLock("offers:"+studentId)`:
1. Load the offer (not the owner → 404).
2. If `extended` and expired → expire it and return `410 OFFER_EXPIRED`.
3. If the status ≠ `extended` → `409 OFFER_NOT_PENDING`.
4. `policy = resolvePolicy(offer.college, offer.academicYear)`. `held` = the student's other `accepted`/`placed` offers.
5. If `held` is non-empty and `policy.enforceOneOffer`:
   - `best = max(held.packageLpa)` and `threshold = round2(best × policy.dreamMultiplier)`;
   - if `allowDreamUpgrade && offer.packageLpa >= threshold` → this is an **upgrade**;
   - otherwise → `409 ONE_OFFER_POLICY` with the message `You have already accepted {company} ({best} LPA). Under the one-offer policy you can only accept a dream offer of at least {threshold} LPA.` and `{currentAcceptedPackage: best, requiredPackageLpa: threshold}`.
6. Atomically flip to `accepted` (`respondedAt`, history entry).
7. On an upgrade, flip every held offer (including `placed` ones) to `withdrawn` with the note `Released after accepting a dream offer from {company}`. Sync their applications to `withdrawn` and notify the staff of the released companies.
8. Sync this offer's application to `hired`.
9. Recompute `offerType` for the student's other `extended` offers.
10. Notify staff (`placement.offer.updated`). Return `{offer, released}`.

**`classifyOffer(packageLpa, best, policy)`.** `best` = the highest package among the student's other accepted or placed offers at that moment.
- `best == null` → `normal`
- `packageLpa >= best × superDreamMultiplier` → `super-dream`
- `packageLpa >= best × dreamMultiplier` → `dream`
- otherwise → `normal`

It is set on create, on `PATCH`, and for the remaining `extended` offers after an accept.

**Not enforced:** `maxPendingOffers` is checked only when an offer is created (§6.3). Creating an offer for an already-placed student is allowed; accepting it is what the policy governs.

### 7.4 Offer → application sync (`application.service#syncFromOffer(offer, {byStudent})`)
| offer status | application status | timeline note |
|---|---|---|
| `extended` | `offered` | `Offer extended: {packageLpa} LPA` |
| `accepted`, `placed` | `hired` | `Offer accepted` / `Placement confirmed` |
| `rejected` | `withdrawn` | `Offer declined` |
| `withdrawn` (by the student or by an upgrade release) | `withdrawn` | `Offer acceptance withdrawn` / the release note |
| `withdrawn` (revoked by staff) | `rejected` | `Offer revoked: {reason}` |
| `expired` | `withdrawn` | `Offer expired` |

Offers without an application are not synced. If the status changes because of an offer action the student did not take, the student gets `placement.application.status`. When the offer notification already covers it, set `{notify:false}`.

### 7.5 Training
**Registration** (`POST /training/:id/register`):
- The program must be `upcoming` or `ongoing`, else `409 PROGRAM_CLOSED`.
- `registrationDeadline` must be in the future when it is set, else `409 REGISTRATION_CLOSED`.
- The student must match the audience, else `403 NOT_ELIGIBLE`. To match:
  - `audience.branches` empty, or `branchMatches`;
  - `graduationYears` empty, or it includes the student's `passingYear`;
  - `minCgpa` null, or `cgpa >= minCgpa`. An unknown CGPA does not match.
- An existing `TrainingEnrollment` with status `registered` → `409 ALREADY_REGISTERED`.
- Capacity is claimed with `findOneAndUpdate({_id, enrolledCount: {$lt: capacity}}, {$inc:{enrolledCount:1}})`. A null result → `409 PROGRAM_FULL`.
- Then insert the enrollment, or re-activate a `cancelled` one. On a duplicate-key race, decrement `enrolledCount` and return `409 ALREADY_REGISTERED`.

**Unregister:** allowed only while the program is `upcoming`. It sets `status: cancelled` and decrements `enrolledCount`.

**Attendance** (`POST /:id/attendance`):
- `present:true` → push `{sessionIndex, date: schedule[i].date, markedAt, markedBy, method:"manual"}` with a filter of `"attendance.sessionIndex": {$ne: i}`, so it is idempotent.
- `present:false` → `$pull` that session index.
- Indices refer to the sorted schedule.

**Status sweep** (§11), using day boundaries in `APP_TIMEZONE`:
- `upcoming` → `ongoing` when today ≥ the first session day. Enrollments in `enrolled` → `in-progress`.
- `ongoing` → `completed` when today > the last session day.
- `completionStatus` → `completed` / `dropped` and `certificateUrl` are set by the TPO.

`PATCH` with schedule or venue changes, and `cancel`, notify registered students (`training.updated`). Creation notifies the audience students (`training.new`).

---

## 8. AI job creator and agent metadata
**`backend/src/websocket/job-service.js`** becomes:
```js
import { upsertAiCreatedJob, listJobsForAgentMetadata } from "../modules/placements/services/drive.service.js";
export const getEligibilityJobs = (user = null) => listJobsForAgentMetadata(user);
export const persistConfirmedJob = ({ job, user, sessionId, draftId }) => upsertAiCreatedJob({ job, user, sessionId, draftId });
```

**`upsertAiCreatedJob`.** The signature, the returned Mongoose document and the error messages stay compatible, because `ai-query-handler.js` shows `error.message` to the user.
1. `user.role` must be `tpo` or `admin`, else `Error("Only an authenticated TPO can create a job")`.
2. `company_name`, `job_role`, `job_description` and `app_deadline` must all be present, else `Error("Confirmed job payload is missing required fields")`.
3. An invalid `app_deadline` → `Error("Confirmed job has an invalid application deadline")`. A past one → `Error("Confirmed job has an application deadline in the past")`.
4. **Fixes the "one job per chat session" overwrite.** Compute the idempotency key:
   - `sourceDraftKey = draftId ? "draft:" + draftId` (accept `/^[A-Za-z0-9_-]{1,64}$/`)
   - otherwise `"fp:" + sha1(normalize(company_name) + "|" + normalize(job_role)).slice(0, 24)`, where `normalize` = lowercase, trim and collapse spaces.
5. Upsert on `{createdBy: user._id, sourceSessionId: sessionId, sourceDraftKey}` with `{upsert:true, returnDocument:"after", runValidators:true, setDefaultsOnInsert:true, includeResultMetadata:true}`.
   - The result: a second, different job in the same chat creates a **new** document; re-posting the same company and role after edits **updates** it; a duplicate "post it" stays idempotent.
   - Mapped fields: everything the current code sets, plus `packageLpa`/`packageMaxLpa` (from `salary`), `college: user.college`, `createdByRole: user.role` and `status:"active"`.
   - Also mapped when present in the payload: `drive_date`, `min_tenth_percentage`, `min_twelfth_percentage` and `rounds`.
6. After the upsert, run `Job.updateOne({_id, publishedAt:null}, {$set:{publishedAt:now}})`, then call `events.drivePublished(job)`. The atomic `notifiedAt` claim (§7.1) means the eligible-student fan-out runs once per drive, however often it is re-posted. The fan-out is fire-and-forget and never delays the chat response.
7. Return the document. The handler still reads `persistedJob._id`.

**`ai-query-handler.js#persistJobCreationResponse`:** `persistConfirmedJob({ job: payload.data.job, user, sessionId, draftId: payload.data?.draft_id })`.

**Old index:** dropped by §3.8 before the server listens. Without that, a second job in the same session would hit E11000.

**`listJobsForAgentMetadata(user)`:**
- `null` user → `[]`.
- Otherwise: active drives in `jobScope(user)`, sorted by deadline asc, at most 100.
- It keeps every existing snake_case key: `job_id, job_title, description, company_id, company_name, salary, location, employment_type, min_cgpa, max_backlogs, allowed_branches, allowed_graduation_years, skills, selection_process, application_deadline, status`.
- It adds `package_lpa, drive_date, min_tenth_percentage, min_twelfth_percentage`.
- For students it also adds:
  - `server_eligibility: {eligible, status, code, reasons, missing}`
  - `my_application_status: string | null`

  For other roles both keys are `null`.

**`metadata-builder.js`:**
- Pass `user` in both calls.
- Add a rule to `ELIGIBILITY_CONTRACT.rules`: `"When a job has server_eligibility, report that verdict and its reasons; never re-evaluate it."`

**`auth-context.js#buildProfile`.** Stored values win over client `details`:
- `cgpa: user.cgpa ?? student?.overallCGPA ?? details.cgpa ?? null`
- `active_backlogs: user.activeBacklogs ?? details.active_backlogs ?? details.activeBacklogs ?? null`
- `tenth_percentage: user.tenthPercentage ?? details…`
- `twelfth_percentage: user.twelfthPercentage ?? details…`
- `graduation_year: (parseInt(user.passingYear, 10) || null) ?? details.graduation_year ?? details.graduationYear ?? null`
- `college: user.collegeName || student?.university || ""`

---

## 9. Notifications (all through `notify()`, in `services/events.js`)
Use `email: true` where the table says so; `notify` applies the user's preferences. Recipient sets:
- **TPOs** = `User{role:"tpo", college: X, isActive != false}`, falling back to `role:"admin"` when there are none.
- **recruiters** = `User{role:"company", company: X, isActive != false}`, within the job's college scope.

Dates use `formatDay` / `formatDateTime`, and titles are cut to 140 characters.

| type | trigger | recipients | title | body | ui | priority | email | dedupeKey |
|---|---|---|---|---|---|---|---|---|
| `placement.drive.new` | first publish (§7.1) | `findEligibleStudentIds(job)` | `New drive: {Company} – {Title}` | `{packageLabel} · {location \|\| "Location TBA"} · Apply by {deadline}` | `{panel:"jobs.detail", params:{jobId, source:"campus"}}` | normal | ✓ | `drive-new:{jobId}` |
| `placement.drive.deadline` | sweep, ≤ `DRIVE_DEADLINE_REMINDER_HOURS` before the deadline | eligible students who have not applied | `Last chance: {Company} – {Title}` | `Applications close {deadline datetime}.` | `{panel:"jobs.detail", params:{jobId, source:"campus"}}` | normal | – | `drive-deadline:{jobId}` |
| `placement.drive.pending` | a company creates a drive, or resubmits a rejected one | TPOs of `job.college` | `Drive awaiting approval: {Company} – {Title}` | `Submitted by {recruiter name}.` | `{panel:"tpo.drives", params:{jobId, status:"pending"}}` | high | ✓ | `drive-pending:{jobId}:{updatedAt ms}` |
| `placement.drive.status` | a TPO publishes, rejects or closes a company drive | the company's recruiters | `Drive {approved\|rejected\|closed}: {Title}` | the review note | `{panel:"company.drives", params:{jobId}}` | normal | ✓ | – |
| `placement.application.new` | a student applies or re-applies (§7.2 step 8) | recruiters of `job.company` (not TPOs) | `New applicant: {Student} – {Title}` | `{branch} · CGPA {cgpa}` | `{panel:"company.applicants", params:{jobId, applicationId}}` | low | – | `app-new:{applicationId}:{timeline.length}` |
| `placement.application.status` | a staff change, a staff add, or an offer sync not caused by the student | the student | `{Company} – {Title}: {statusLabel}` | the note, or the default below | `{panel:"applications", params:{applicationId}}` | high for shortlisted, interview and hired; normal otherwise | shortlisted, interview | `app-status:{applicationId}:{timeline.length}` |
| `placement.offer.new` | offer created | the student | `Offer from {Company}: {packageLpa} LPA` | `{roleTitle}. Respond by {expiresAt}.` | `{panel:"offers", params:{offerId}}` | high | ✓ | `offer-new:{offerId}` |
| `placement.offer.updated` (to the student) | place, override, revoke, `PATCH`, expire | the student | `Your {Company} offer: {OFFER_STATUS_LABEL}` (`PATCH`: `Your {Company} offer was updated`) | the note | `{panel:"offers", params:{offerId}}` | high | – | `offer-upd:{offerId}:{statusHistory.length}` |
| `placement.offer.updated` (to staff) | the student accepts, rejects or withdraws; an upgrade release; expiry | TPOs of `offer.college` + recruiters of `offer.company` | `{Student} {accepted\|declined\|withdrew from\|let expire} the {Company} offer` | `{packageLpa} LPA · {roleTitle}{reason ? " — " + reason : ""}` | TPO `{panel:"tpo.offers", params:{offerId}}`; recruiter `{panel:"company.applicants", params:{jobId, applicationId}}` | normal | – | `offer-resp:{offerId}:{statusHistory.length}` |
| `placement.offer.expiring` | sweep, ≤ `OFFER_REMINDER_HOURS` before `expiresAt` | the student | `Your {Company} offer expires {expiresAt datetime}` | `Accept or decline it before it expires.` | `{panel:"offers", params:{offerId}}` | high | ✓ | `offer-expiring:{offerId}` |
| `placement.announcement` | announce (REST or tool) | the resolved audience | the given title | the given body | none | normal | as requested | – |
| `training.new` | program created | active audience students in the college | `New training: {title}` | `{type} · starts {schedule[0].date} · {schedule[0].venue}` | `{panel:"training", params:{programId}}` | normal | – | `training-new:{programId}` |
| `training.updated` | schedule or venue `PATCH`; cancel | registered students | `Training updated: {title}` / `Training cancelled: {title}` | a change summary, or the cancel reason | `{panel:"training", params:{programId, tab:"mine"}}` | normal (cancel: high) | – | – |

**Default application bodies:**

| status | body |
|---|---|
| shortlisted | `You have been shortlisted. Watch for interview details.` |
| interview | `You have been moved to the interview round.` |
| rejected | `Thank you for applying. You were not selected this time.` |
| offered | `You have an offer. Open My Offers to respond.` |
| hired | `Congratulations! Your offer is confirmed.` |
| withdrawn | `Your application was withdrawn.` |

**OFFER_STATUS_LABEL:**

| status | label |
|---|---|
| extended | Pending response |
| accepted | Accepted |
| rejected | Declined |
| withdrawn | Withdrawn |
| expired | Expired |
| placed | Placed |

**Reminder suppression:** the reminders are skipped (and the flag is set without sending) when the drive was published, or the offer created, less than the reminder window before the deadline.

Tests replace the notifier with `setNotifier(fn)`. The default is `notify` from `backend/src/modules/notifications/notify.js`.

---

## 10. Socket events (server → client only, through `core/realtime.js`)
Panels listen with `useSocketEvent` and refetch. Payloads stay minimal on purpose, so nothing leaks across roles.

| event | room(s) | payload | when |
|---|---|---|---|
| `placement:application` | `user:<studentId>` | `{application: ApplicationStudentView}` | any change to the student's application |
| `placement:applicants` | `user:<id>` of TPOs (college) + recruiters (company) | `{applicationId, jobId, status, action: "created"\|"updated"\|"withdrawn"}` | apply, withdraw, staff change, offer sync |
| `placement:offer` | `user:<studentId>` | `{offer: OfferStudentView}` | every offer change |
| `placement:offers` | TPOs + recruiters as above | `{offerId, status, action}` | every offer change |
| `placement:job` | TPOs + recruiters as above | `{jobId, status, action: "created"\|"updated"\|"published"\|"rejected"\|"closed"\|"deleted"}` | drive changes |
| `placement:training` | registered students' `user:` rooms | `{programId, action: "updated"\|"cancelled"}` | training `PATCH` or cancel |

There are no client → server events and no `registerSocket`.

---

## 11. Background jobs (`services/sweep.js`)
A single job runs: `registerJob("placements.sweep", PLACEMENT_SWEEP_INTERVAL_MS, runSweep, {runOnStart:true})`. The scheduler is disabled under `NODE_ENV=test`, so tests call `runSweep()` with `setClock`.

Each step is independent, with its own try/catch, and processes at most 500 documents per tick:
1. **Auto-close.** `active` drives with `applicationDeadline <= now` → `closed` with `closedReason:"deadline"` and `closedAt`. Emits `placement:job`.
2. **Expire offers.** `extended` offers with `expiresAt <= now` → `expired`, per document (§7.3).
3. **Offer reminders.** `extended` offers with `expiresAt` in `(now, now + OFFER_REMINDER_HOURS]` and `reminderSentAt:null` → `placement.offer.expiring`. Set `reminderSentAt`.
4. **Deadline reminders.** `active` drives with `applicationDeadline` in `(now, now + DRIVE_DEADLINE_REMINDER_HOURS]` and `deadlineReminderSentAt:null` → recipients are `findEligibleStudentIds(job, {excludeApplied:true})`. Set `deadlineReminderSentAt`.
5. **Training statuses** (§7.5).

Lazy expiry: `GET /offers/my` and accept/reject run step 2 for that student first.

---

## 12. Agent tools (`tools.js`; names and arguments follow AGENT-TOOLS.md §5)
- **Handlers** call the same services as the REST routes and get `ctx.user` (a fresh User document).
- **Errors** are `fail(...)` ApiErrors, which come back as `{ok:false, error: code, message}`.
- **`confirm:true` tools** implement `preview(args, ctx) → {summary, args}`. `args` is **normalised with resolved ids**, so the confirmed re-run never re-resolves fuzzy text. The preview runs every read-only check (scope, eligibility, transition validity) and **throws the same error** the handler would, so the copilot never asks the user to confirm an action that is sure to fail.
- **Summaries** are ≤ 600 characters, and `data` arrays are capped (jobs ≤ 20, applications ≤ 50).

### 12.1 Fuzzy references (`services/resolve.js`)
Each reference accepts a 24-hex id first. Otherwise the text is resolved inside the caller's scope.

| ref | text matching |
|---|---|
| `job` | Every whitespace token must match (escaped, case-insensitive) somewhere in `"{companyName} {title}"`. Prefer `active`. |
| `application` | Student: the job text among their own applications. Staff: `"<student>"` or `"<student> for\|@\|at <job>"`. `<student>` matches an exact email, an exact `rollNumber` / `ggsipuEnrollment`, or every token of the name. |
| `offer` | The student's offers by company or role text; prefer `extended`. |
| `program` | The title regex among visible `upcoming`/`ongoing` programs. |
| `resumeId` | An id, or the case-insensitive exact title of one of the student's active resume-bank resumes. |

**Outcomes:**
- 0 matches → `fail(404, "No drive matches '<text>'", "NOT_FOUND")`, with the noun changing per ref.
- 1 match → use it.
- More than 1 → an exact case-insensitive title or label match wins if it is unique. Otherwise return `{ambiguous:true, message:"Which drive do you mean?", candidates:[{id, label}]}` with at most 8 candidates.

**Candidate labels:**
- drive: `"{Company} – {Title} ({status}, apply by {formatDay})"`
- application: `"{Student} – {Company} {Title} ({status})"`
- offer: `"{Company} – {packageLpa} LPA ({status})"`
- program: `"{title} (starts {formatDay})"`

### 12.2 Catalogue
| tool | roles | confirm | parameters (JSON-schema subset) | behaviour → `{summary, data, ui}` |
|---|---|---|---|---|
| `jobs_search_campus` | student, tpo, admin, company | – | `query?` string, `location?` string, `minPackageLpa?` number, `eligibleOnly?` boolean, `limit?` integer 1–20 (default 8) | Active drives in `jobScope` (company: its own). Students are sorted eligible-first, then `matchPercentage` desc, then deadline. Summary: `Found 5 open campus drives (3 you're eligible for): Google – SDE (18 LPA, apply by 2 Dec); …` (top 3), or `No open campus drives match "<query>".` · data `{jobs: AgentJobSummary[]}` · ui: student `{panel:"jobs.campus", params:{query, location, minPackageLpa, eligibleOnly}}`; tpo/admin `{panel:"tpo.drives", params:{query}}`; company `{panel:"company.drives", params:{query}}` |
| `job_details` | all roles | – | `job` string (required) | The role's view. Summary: `{Company} – {Title}: {packageLabel}, {location}. Apply by {deadline}.` plus for students `You are eligible.` / `Not eligible: {reason}` / `Your application: {statusLabel}.`, and for staff `{applicantCount} applicants.` · data `{job}` · ui: student `{panel:"jobs.detail", params:{jobId, source:"campus"}}`; tpo/admin `{panel:"tpo.drives", params:{jobId}}`; company `{panel:"company.drives", params:{jobId}}`; teacher/alumni none (UI-ACTIONS has no panel for them) |
| `drive_apply` | student | ✓ | `job` string (required), `resumeId?` string, `coverNote?` string ≤2000 | Preview: `Apply to {Company} – {Title} ({packageLabel}) with resume "{title}"? Applications close {deadline}.` (or `… without a resume?`). Handler: apply with `source:"agent"`. Summary: `Applied to {Company} – {Title}. You can track it under Applications.` · data `{application}` · ui `{panel:"applications", params:{applicationId}}` |
| `applications_list` | student | – | `status?` enum of application statuses | Summary: `You have 4 applications: Google – SDE (Shortlisted); …` · data `{applications: ApplicationStudentView[]}` · ui `{panel:"applications", params:{status}}` |
| `application_withdraw` | student | ✓ | `application?` string, `job?` string | Resolve by `application`, else by `job` among the student's applications, else the only active one, else ambiguous. Preview: `Withdraw your application to {Company} – {Title} (currently {statusLabel})? You can re-apply until {deadline}.` Summary: `Withdrew your application to {Company} – {Title}.` · data `{application}` · ui `{panel:"applications", params:{applicationId}}` |
| `offers_list` | student, tpo, admin | – | none | Student: own offers. Summary: `You have 2 offers: Google 18 LPA (Pending response, reply by 30 Nov); …` · ui `{panel:"offers"}`. Staff: the current academic year in scope. Summary: `{n} offers in {AY}: 3 pending, 6 accepted, 2 placed, 1 declined.` · ui `{panel:"tpo.offers"}` · data `{offers (≤20), statusCounts?}` |
| `offer_respond` | student | ✓ | `offer?` string, `job?` string, `decision` enum `accept`\|`reject` (required), `reason?` string | Resolve by `offer`, else the offer for `job`, else the only `extended` one, else ambiguous. Preview: accept → `Accept the {Company} offer ({packageLpa} LPA, {role})?` plus `Your accepted {X} offer ({p} LPA) will be released.` on an upgrade, or `Under the one-offer policy you will then only be able to apply to drives offering at least {t} LPA.`; reject → `Decline the {Company} offer ({packageLpa} LPA)? This cannot be undone.` The preview raises ONE_OFFER_POLICY / OFFER_EXPIRED / OFFER_NOT_PENDING. Summary: `Accepted the {Company} offer.` / `Declined the {Company} offer.` · data `{offer, released?}` · ui `{panel:"offers", params:{offerId}}` |
| `training_list` | student, tpo, admin | – | `mine?` boolean | Student with `mine` → their enrollments; otherwise programs (`upcoming,ongoing`). Summary: `3 upcoming programs: Aptitude Bootcamp (starts 2 Dec, 48 seats left); …` · data `{programs}` or `{enrollments}` · ui: student `{panel:"training", params:{tab: mine ? "mine" : "discover"}}`; tpo/admin `{panel:"tpo.training"}` |
| `training_register` | student | ✓ | `program` string (required) | Preview: `Register for {title} (starts {date}, {venue})? {seatsLeft} seats left.` Summary: `Registered for {title}.` · data `{enrollment}` · ui `{panel:"training", params:{tab:"mine", programId}}` |
| `drives_list` | tpo, admin, company | – | `status?` enum `draft`\|`pending`\|`active`\|`closed`\|`rejected`\|`all` (default `all`) | Summary: `{n} drives: 5 active, 2 pending approval, 1 closed. Pending: Infosys – SE; …` · data `{jobs: AgentJobSummary[] (+applicantCount)}` · ui `{panel: company ? "company.drives" : "tpo.drives", params:{status}}` |
| `drive_create` | tpo, admin, company | ✓ | `title`, `company`, `description`, `deadline` strings (required); `salary?`, `location?`, `employmentType?` strings; `minCgpa?` number; `maxBacklogs?` integer; `branches?`, `graduationYears?`, `skills?` string arrays | Maps to the drive input (§6.1): `company`→companyName (ignored for company users), `deadline`→applicationDeadline (chrono, end of day), `minCgpa`, `maxBacklogs`, `branches`. Preview: `Create {Company} – {Title} ({packageLabel}, {location}), apply by {deadline datetime}, min CGPA {x}, branches {list}?` plus `It will be published to {n} eligible students now.` (tpo) or `It will be sent to the placement office for approval.` (company). Summary: `Published {Company} – {Title}. {n} eligible students notified.` / `Submitted {Company} – {Title} for TPO approval.` · data `{job}` · ui `{panel: company ? "company.drives" : "tpo.drives", params:{jobId}}` |
| `drive_close` | tpo, admin, company | ✓ | `job` string (required) | Preview: `Close {Company} – {Title} for new applications? {k} applicants so far; their applications are not changed.` Summary: `Closed {Company} – {Title}.` · data `{job}` · ui as for `drives_list` with `{jobId}` |
| `applicants_list` | tpo, admin, company | – | `job` string (required), `status?` enum of application statuses | Sorted by pipeline order, then CGPA desc; at most 50. Summary: `{n} applicants for {Company} – {Title}: 20 applied, 10 shortlisted, 5 interview, 2 not selected.` · data `{job: AgentJobSummary, applications: ApplicationStaffView[], total, statusCounts}` · ui `{panel: company ? "company.applicants" : "tpo.applicants", params:{jobId, status}}` |
| `application_update_status` | tpo, admin, company | ✓ | `application` string (required), `status` enum `applied`\|`shortlisted`\|`interview`\|`rejected` (required), `note?` string ≤500 | Preview: `Move {Student} ({Company} – {Title}) from {from} to {to}? The student will be notified.` The preview raises USE_OFFER_FLOW / INVALID_TRANSITION. Summary: `{Student} is now {statusLabel} for {Company} – {Title}.` · data `{application}` · ui `{panel: company ? "company.applicants" : "tpo.applicants", params:{jobId, applicationId}}` |
| `offer_create` | tpo, admin, company | ✓ | `application` string (required), `ctc` string or number (required, LPA or text), `role?` string, `joiningDate?` string, `expiresAt?` string | Maps to the offer input (`ctc`→`parsePackageLpa(ctc).min`, `role`→`roleTitle`). Preview: `Extend an offer to {Student} for {Company} – {roleTitle} at {packageLpa} LPA ({offerType} offer), expiring {expiresAt}?` Summary: `Offer extended to {Student} ({packageLpa} LPA). They have until {expiresAt} to respond.` · data `{offer}` · ui tpo/admin `{panel:"tpo.offers", params:{offerId}}`, company `{panel:"company.applicants", params:{jobId, applicationId}}` |
| `placement_stats` | tpo, admin | – | none | The current academic year, college scope. Summary: `{AY}: {placedPercent}% placed ({placed}/{students}). Average {avg} LPA, median {median} LPA, highest {max} LPA. {extended} offers awaiting a response. Top recruiters: Google (6), Amazon (5).` · data `{stats}` · ui `{panel:"tpo.analytics", params:{academicYear}}` |
| `announce` | tpo, admin | ✓ | `title` string (required), `body` string (required), `audience` object `{roles?: string[], branch?: string, passingYear?: string}` (required) | Preview: `Send "{title}" to {n} {roles} ({branch}, {passingYear})?` The preview raises NO_RECIPIENTS / TOO_MANY_RECIPIENTS. Summary: `Announcement sent to {n} users.` · data `{recipients}` · no ui |
| **`drive_review`** *(EXTENSION: add to AGENT-TOOLS §5)* | tpo, admin | ✓ | `job` string (required), `decision` enum `approve`\|`reject` (required), `note?` string | `approve` → publish; `reject` → reject (`note` required). Preview: `Approve {Company} – {Title} and notify {n} eligible students?` / `Reject {Company} – {Title}? The recruiter will see your note.` Summary: `Approved …; {n} students notified.` / `Rejected ….` · data `{job}` · ui `{panel:"tpo.drives", params:{jobId}}` |

---

## 13. Environment variables (`modules/placements/config.js`; read once at import)
| name | default | meaning |
|---|---|---|
| `ACADEMIC_YEAR_START_MONTH` | `7` | First month (1–12) of the academic year in `APP_TIMEZONE`. With 7, `"2026-27"` starts on 1 Jul 2026. |
| `PLACEMENT_SWEEP_INTERVAL_MS` | `300000` | Interval of the `placements.sweep` job (minimum 30000). |
| `OFFER_REMINDER_HOURS` | `24` | Remind students this many hours before an offer expires. `0` turns it off. |
| `DRIVE_DEADLINE_REMINDER_HOURS` | `24` | Remind eligible students who have not applied this many hours before the deadline. `0` turns it off. |
| `PLACEMENT_COMPANY_AUTO_APPROVE` | `false` | `true` → company drives are published right away, with no TPO review. |
| `PLACEMENT_ANNOUNCE_MAX_RECIPIENTS` | `5000` | Cap on the audience of one announcement. |

It also reuses `APP_TIMEZONE`, `APP_NAME` and `FRONTEND_URL` (`config/config.js`), plus the `SMTP_*` settings through `core/mailer.js`. Test-only: `MONGO_TEST_URI` (§16).

---

## 14. Frontend touch-points
Existing components keep their paths, because the backend returns the shapes they read:
- `OfferManagement.jsx` reads `{offers, total}`.
- `StudentOffers.jsx` reads an array of offers.
- `PolicyConfigPanel.jsx` reads the PolicyView itself.
- `TrainingHub.jsx` and `TrainingScheduler.jsx` read arrays.
- `CompanyMode.jsx` keeps its `POST /jobs` payload.
- `DriveCard.jsx` keeps `POST /drives/:id/apply`.
- `LearningRecommendationWorkspace.jsx` keeps `GET /interviews/my`.

**Required edits** (minimal, so the existing UI shows correct data):
1. **`App.jsx` `fetchStudentDashboardData`** (lines 136–149). Map these fields from the server: `isEligible: job.isEligible !== false`, `eligibilityReason: job.eligibilityReason || ""`, `minCgpa: job.minimumCgpa ?? "—"`, `matchPercentage: job.matchPercentage`, `packageLpa: job.packageLabel || job.salary || "Not disclosed"`, `applicationStatus: job.myApplication?.status || null`, `applicationStatusLabel: job.myApplication?.statusLabel`, `canApply: job.canApply`, `applyBlockedReason: job.applyBlockedReason`. Remove the hard-coded `isEligible: true`.
2. **`App.jsx` `handleAuthSuccess`.** Role `company` → initial mode `"company"`, with the mode already chosen.
3. **`DriveCard.jsx`.**
   - Show the FIT badge only when `typeof matchPercentage === "number"`.
   - Replace the fallbacks `"12 LPA"` → `"Not disclosed"` and `"Remote"` → `"Location TBA"`.
   - Disable APPLY when `canApply === false` and show `applyBlockedReason`.
   - Show `applicationStatusLabel` instead of a fixed "APPLIED".
   - On error, alert `e.response?.data?.message`.
4. **`StudentMode.jsx` APPLICATION TRACKING** (lines 324–346) and its badge count. Use `GET /applications/my` (company, role, status label, last update) instead of filtering `databaseJobs`.
5. **`TrainingHub.jsx`** (lines 92–100, 136–143) and **`TrainingScheduler.jsx`** (lines 84–90).
   - Use `const s = prog.nextSession ?? prog.schedule?.[0]` and render "Schedule TBA" when it is null.
   - Use `entry.program.schedule?.length ?? 0`.
   - Guard `capacity` (`capacity ? enrolled/capacity : 0`).

   The server already guarantees `schedule.length ≥ 1` and `capacity ≥ 1` for every program it returns, but the old crash and division by zero must not come back with bad data.
6. **`ProfileModal.jsx`.** Students get inputs for `activeBacklogs`, `tenthPercentage` and `twelfthPercentage`, which `PATCH /auth/me` saves.
7. **New `frontend/src/lib/api/placements.js`.** It wraps every new endpoint with the shared `http` client from `lib/http.js`, which unwraps `data` and normalises errors to `ApiClientError`. Downloads use `responseType:"blob"`.

**Panels: the data each one reads.** UI-ACTIONS §3 owns the panel ids and component names, and FRONTEND.md decides who builds them. Every panel listens to the §10 socket events and refetches.

| panel id(s) | component (UI-ACTIONS §3) | placements endpoints |
|---|---|---|
| `jobs.campus`, `jobs.detail` | `JobsHub` | `GET /jobs` (StudentJobView[]), `GET /jobs/:id`, `GET /jobs/:id/eligibility` (checks table), `POST /drives/:id/apply`. Optional: the matched tab may use `GET /drives/matched` instead of the fabricated jobs-finder listings. |
| `applications` | `ApplicationsPanel` | `GET /applications/my`, `POST /applications/:id/withdraw` |
| `offers` | `StudentOffers` (existing) | `GET /offers/my`, accept / reject / withdraw |
| `training` | `TrainingHub` (existing) | `GET /training`, `GET /training/my`, `POST`/`DELETE /training/:id/register` |
| `calendar`, `tpo.calendar` | `CalendarPanel`, `TpoCalendarPanel` | `GET /jobs` (`driveDate`, `applicationDeadline`, `rounds[].at`), plus `GET /training/my` (students) or `GET /training` (staff) for sessions |
| `tpo.drives`, `company.drives` | `DrivesPanel {scope}` | `GET /jobs?status=` (StaffJobView[]), `POST /jobs`, `PATCH`/`DELETE /jobs/:id`, `POST /jobs/:id/publish\|reject\|close` (company: `close` only), `GET /placements/me` |
| `tpo.applicants`, `company.applicants` | `ApplicantsPanel {scope}` | `GET /jobs/:id/applications` or `GET /applications`, `PATCH /applications/:id/status`, `POST /applications/bulk-status`, `GET …/export.csv` (blob), `GET /applications/:id/resume`, `POST /offers` (an "Extend offer" form; `api.createOffer` has no UI today), `POST /applications` (tpo only) |
| `tpo.offers` | `OfferManagement` (existing) | `GET /offers`, place / override / revoke |
| `tpo.policy` | `PolicyConfigPanel` (existing) | `GET`/`POST /offers/policy` |
| `tpo.analytics` | `PlacementAnalyticsPanel` | `GET /placements/stats` |
| `tpo.training` | `TrainingScheduler` (existing) | `GET /training?status=all`, `POST /training` (the NEW PROGRAM button), `PATCH`, `POST /training/:id/cancel`, `GET /training/:id/enrollments` (the MANAGE roster), `POST /training/:id/attendance`, `PATCH /training/:id/enrollments/:enrollmentId` |

**`CompanyMode.jsx` is rewritten** (this contract assigns it). It hosts `DrivesPanel` and `ApplicantsPanel` with `{scope:"company"}`, shows the real company from `GET /placements/me`, and drops the hard-coded form defaults and the static "VERIFIED RECRUITER" badge. Its posting form keeps the `POST /jobs` payload in §6.1.

In AdminMode, "Application Review" → `tpo.applicants` and "Placement Analytics" → `tpo.analytics` replace COMING SOON. "Eligibility Rules" stays COMING SOON. The recruiter list and invites are AUTH-FACULTY's `tpo.recruiters` panel.

---

## 15. Cross-area dependencies
- **notifications:** `notify()` at `backend/src/modules/notifications/notify.js` (NOTIFICATIONS.md).
  - Types used that UI-ACTIONS §11 already maps: `placement.drive.new`, `placement.drive.pending`, `placement.application.new`, `placement.application.status`, `placement.offer.new`, `placement.offer.updated` and `training.new`.
  - Types this module adds; UI-ACTIONS §11 should list them, and their `ui` already uses registered panels: `placement.drive.deadline`, `placement.drive.status`, `placement.offer.expiring`, `placement.announcement` (no `ui`) and `training.updated`.
- **UI-ACTIONS / frontend:**
  - Panel ids and params follow UI-ACTIONS §3 and the §7 tool → panel table exactly. Tools return the role-specific panel themselves, so the aliases never have to fire. `training` uses `tab: "discover" | "mine"`.
  - Socket events (§10): `placement:application`, `placement:applicants`, `placement:offer`, `placement:offers`, `placement:job` and `placement:training`.
- **AUTH-FACULTY:**
  - **Model names:** the demo seed (§16.4) writes `Job`, `Application`, `Offer`, `TrainingProgram`, `TrainingEnrollment` and `PlacementPolicy` with the field names used here. `Application.resume` and `eligibilitySnapshot` are optional, and the pre-validate hooks fill `academicYear`, `company` and `college`.
  - **Branches:** `canonicalBranch()` in `backend/src/utils/branch.js` is the only branch canonicaliser (§2.5).
  - **Accounts:** recruiter accounts come from `/api/v1/recruiters`, with `role:"company"`, `company` and `college`. Logging in, `isActive` and `mustChangePassword` are enforced there.
  - **Profile fields:** `buildProfileUpdate` gets the three student rows of §3.7.
- **JOB-FEED:**
  - Its model is `ExternalJob` (collection `external_jobs`), mounted at `/api/v1/job-feed`. There is no collision with `Job`/`jobs`, `/api/v1/jobs` or `/api/v1/drives`.
  - The Python jobs-finder calls `jobs_search_campus` and maps `data.jobs[]` through JOB-FEED §12.5 `campus_item`. `AgentJobSummary` (§5) returns the first-named keys it reads.
- **agent-tools:**
  - Loads `placements.tools`. Uses the §5 names plus the extension `drive_review`; the copilot's deterministic planner may add intents for it.
  - When a `preview` throws an ApiError, `/execute` must answer it like a handler error, `200 {ok:false, error: errors[0].code, message}`, and must **not** return `needs_confirmation`. A preview may also return `{ambiguous:true, …}`, which is answered as `AMBIGUOUS`.
- **ai-service:**
  1. `app/agents/job_eligibility/agent.py#_run_metadata_check`: when a job has `server_eligibility`, use its `eligible` and `reasons` and skip `evaluate_eligibility` and `_next_missing_profile_field` for that job.
  2. `session.py#merge_metadata`: fresh metadata overwrites profile keys, and `jobs_by_id` is replaced, not merged.
  3. `job_creator`: put `draft_id` (a uuid4 hex per draft) in `post_chunk` `data`, and reset or delete the session after posting.

  Node already prevents overwrites without these changes.
- **resume-bank / resume-lab:**
  - Applications reference the resume-bank `Resume` (`owner`, `status:"active"`, `version`) and call `buildPrivateResumeUrl()`.
  - If resume-lab renames or replaces that model, it must also update `application.service.js#resolveStudentResume` and `GET /applications/:id/resume`.
- **websocket layer:** the edits listed in §0.2 to `job-service.js`, `ai-query-handler.js`, `metadata-builder.js` and `auth-context.js`.
- **backend/package.json** (shared): the `test` script and the `mongodb-memory-server` devDependency.

---

## 16. Acceptance tests (`node --test`, mongodb-memory-server or `MONGO_TEST_URI`, supertest against `app` from `src/app.js`)
**Harness** (`backend/test/placements/helpers.js`):
- Before importing `app`, set `NODE_ENV=test`, `ACCESS_TOKEN_SECRET`, `ACCESS_TOKEN_EXPIRY=15m` and `REFRESH_TOKEN_SECRET`. Also set `SMTP_SERVICE`, `SMTP_HOST` and `SMTP_USER` to `""`. `config.js` loads `./.env` with dotenv, which never overrides variables that are already set, so a developer's `.env` cannot make tests send real mail.
- Connect mongoose to the memory server, or to `MONGO_TEST_URI` with a unique db per file.
- `clearDb()` runs `beforeEach`.
- Factories: `makeCollege()`, `makeUser({role, college, company, cgpa, branch, passingYear, activeBacklogs, …})`, `bearer(user)` (`user.generateAccessToken()`).
- Hooks: `captureNotifications()` (via `setNotifier`, returns `calls[]`) and `setClock()`.
- Close the connections in `after` so the process exits.

Every scenario below must pass.

**Unit (pure, no DB):**
- **U1:** `parsePackageLpa` gives every vector in §2.4.
- **U2:** `academicYearFor`. 30 Jun 2026 23:59 IST → `"2025-26"`; 1 Jul 2026 00:00 IST → `"2026-27"`. `isValidAcademicYear("2026-2027")` is false.
- **U3:** `branchMatches` over the shared `canonicalBranch` (`utils/branch.js`).
  - true: `("B.Tech (Computer Science & Engineering)", ["CSE"])`, `("cse", ["Computer Science"])`, `("Information Technology", ["IT"])`, `("Artificial Intelligence and Data Science", ["AIDS"])`, `("x", ["All branches"])`, `("Mechatronics", ["mechatronics"])` (an unknown branch matches by normalized text)
  - false: `("Mechanical Engineering", ["CSE","IT"])`
- **U4:** `evaluateEligibility`.

  | case | expected |
  |---|---|
  | all criteria met | eligible |
  | cgpa 6.8 vs 7.5 | ineligible / NOT_ELIGIBLE, reason text exact |
  | job sets max backlogs, student value null | incomplete, `missing:["activeBacklogs"]` |
  | cgpa fail + a missing value | ineligible |
  | graduation year mismatch | ineligible |
  | held 6 LPA, multiplier 1.5, drive 8 | POLICY_BLOCKED |
  | held 6 LPA, multiplier 1.5, drive 9 | eligible with `isDreamUpgrade` |
  | `allowDreamUpgrade:false` | blocked |
  | drive package null | blocked |
  | `enforceOneOffer:false` | eligible |

- **U5:** `skillMatch(["React.js","Node"], ["react","nodejs","SQL"])` → 67, matched `[react, nodejs]`, missing `[SQL]`.
- **U6:** `classifyOffer` with held 10: 12→normal, 15→dream, 20→super-dream; held null → normal.
- **U7:** `parseDateInput`. `"2026-12-05"` with `endOfDay` → `2026-12-05T18:29:59.999Z`. An ISO string passes through. `"next friday"` against a fixed clock gives the expected day. Garbage → VALIDATION.
- **U8:** `toCsv`. Quoting, doubled quotes, the BOM, `=SUM(A1)` → `'=SUM(A1)`.
- **U9:** the transition table (§7.2): every allowed and forbidden pair, including the company-cannot-reopen rule.

**Drives:**
- **J1:** A recruiter posts the exact `CompanyMode.jsx` payload with `packageLpa:"18 LPA"`, `deadline` and `driveDate` as `YYYY-MM-DD`, and a different `companyName` → 201.
  - The drive is `pending`, has `packageLpa` 18 and `salary` "18 LPA".
  - `eligibleBranches` and `skills` are mapped.
  - The deadline is the end of the day and `driveDate` the start of the day, IST.
  - `company` is the recruiter's own company.
  - TPOs get `placement.drive.pending` with ui `{panel:"tpo.drives", params:{jobId, status:"pending"}}`.
- **J2:** Students never see `draft`/`pending`/`rejected` drives (list, and `GET /:id` → 404). The TPO sees all statuses with `statusCounts`. Recruiter B gets 404 for company A's drive and an empty list.
- **J3:** Seed students: A eligible, B CGPA too low, C backlogs unknown, D already accepted 20 LPA under the policy.
  - Publishing the pending drive with `packageLpa` 18 notifies exactly `[A]` and returns `notifiedStudents:1`.
  - Publishing again → 409.
  - Close, then re-publish with a future deadline → no second fan-out.
- **J4:** `GET /jobs` as student B after student A applied. The response is an array with `eligibility`, `isEligible`, `myApplication`, `canApply` and `matchPercentage`. `JSON.stringify(body)` contains neither A's `_id` nor A's email, and has no `applications`, `sourceSessionId` or `sourceDraftKey` key.
- **J5:** Migration. Insert raw legacy jobs: one with no `status` and embedded `applications:[{student: <Student id linked to a User>, status:"applied"}]`, plus the old unique index.
  - After `runPlacementMigrations()`: `status` is `active`; `applications` is unset; one Application exists with `source:"migrated"`; the old index is gone; `notifiedAt` is set.
  - Running it again changes nothing.
- **J6:** `DELETE` a drive that has an application → 409 HAS_APPLICATIONS; without applications → 200.
- **J7:** A deadline in the past → 400 DEADLINE_IN_PAST. `driveDate` before the deadline → 400 VALIDATION `field:"driveDate"`. A missing title → 400 VALIDATION `field:"title"`.

**AI job creator:**
- **AI1:** `persistConfirmedJob` as a TPO in session S:
  - job X and then job Y (a different role) → **2 documents**;
  - X re-posted with a new salary → still 2, and X is updated;
  - `draftId:"d1"` keys by draft;
  - a student user throws "Only an authenticated TPO can create a job";
  - a past deadline throws;
  - a new document has `college`, `createdByRole:"tpo"`, `status:"active"` and the parsed `packageLpa`, and the notifier is called only for the first insert of each.
- **AI2:** `getEligibilityJobs(student)` returns only in-scope active drives with `server_eligibility` and `my_application_status`. `getEligibilityJobs(null)` → `[]`. Keys such as `job_id` and `min_cgpa` are still present.

**Applications:**
- **A1:** Apply as a student whose stored CGPA is 8 while the body sends `cgpa: 10`.
  - The answer is 201, and `eligibilitySnapshot.profile.cgpa === 8`.
  - `college` and `company` are set.
  - A raw active `Resume` owned by the student is attached automatically.
  - The drive company's recruiter gets `placement.application.new`, and the student gets no notification.
- **A2:**
  - ineligible → 403 NOT_ELIGIBLE, with `errors[0].reasons[0]` mentioning CGPA;
  - incomplete → 422 PROFILE_INCOMPLETE `missing:["activeBacklogs"]`;
  - deadline passed → 409 DEADLINE_PASSED;
  - `closed` → 409 DRIVE_NOT_OPEN;
  - a second apply → 409 ALREADY_APPLIED;
  - two **concurrent** applies → exactly one 201 and one 409;
  - another student's `resumeId` → 404 RESUME_NOT_FOUND.
- **A3:** Withdraw → `withdrawn`. Re-apply → 200 with the same `_id`, status `applied` and 3 timeline entries.
- **A4:** TPO changes `applied → shortlisted`: one notification of type `placement.application.status` with ui `{panel:"applications", params:{applicationId}}`.
  - `shortlisted → offered` → 409 USE_OFFER_FLOW.
  - `withdrawn → shortlisted` → 409 INVALID_TRANSITION.
  - A recruiter reopening `rejected` → 409; the TPO reopening it → 200.
  - Setting the same status → `changed:false` with no notification.
- **A5:** Bulk with `[valid, same-status, withdrawn, other-company]` → `updated:1, unchanged:1, failed:2` with codes INVALID_TRANSITION and NOT_FOUND.
- **A6:** Recruiter B gets 404 for company A's application, and `GET /applications` returns only B's.
- **A7:** CSV. `content-type` starts with `text/csv`, the header row equals §6.2, a name containing a comma is quoted, a student named `=HYPERLINK("x")` is exported with a `'` prefix, and only scoped rows appear.
- **A8:** The TPO adds an ineligible student: without `overrideEligibility` → 403 NOT_ELIGIBLE; with it and a note → 201 with `source:"tpo"`, snapshot status `override`, and the student notified.

**Offers and policy:**
- **O1:** Create an offer from an application → the application is `offered`.
  - `GET /offers/my` returns an **array** whose items have every field in OfferStudentView.
  - The notifier is called with `placement.offer.new` and ui `{panel:"offers", params:{offerId}}`.
- **O2:** `GET /offers` (TPO) → `{offers, total, statusCounts}`. `?status=extended` filters. `offers[0].student` has `name`, `email`, `branch` and `cgpa`.
- **O3:** Set up three applications before the first accept, because the one-offer policy blocks later applies. Extend offers of 10, 12 and 16 LPA. Accept the 10 LPA offer → `accepted`, and its application is `hired`; staff are notified.
  - Accepting the 12 LPA offer afterwards (accepted 10, multiplier 1.5) → 409 ONE_OFFER_POLICY with `requiredPackageLpa:15`.
  - A 16 LPA offer → accepted; the 10 LPA offer becomes `withdrawn` with the release note and appears in `released`.
- **O4:** `enforceOneOffer:false` → both accepts succeed.
- **O5:**
  - Reject → `rejected`, and the application is `withdrawn`.
  - Withdraw from `extended` → 409; withdraw from `accepted` → 200.
  - Place from `extended` → 409.
  - Override without a note → 400; with a note → `tpoOverride:true` and a history entry.
  - Revoke → `withdrawn`, and the application is `rejected`.
- **O6:** An offer with `expiresAt` in the past:
  - after `runSweep()` → `expired`, the application is `withdrawn`, and the student is notified;
  - a separate unswept expired offer → accept → 410 OFFER_EXPIRED and the status is now `expired`.
- **O7:** `maxPendingOffers:1` → a second `extended` offer for the same student → 409 MAX_PENDING_OFFERS.
- **O8:** Policy.
  - `GET /offers/policy` with nothing saved → `isDefault:true` and the exact `defaultPolicy()` values.
  - `POST` with `dreamMultiplier:1.0`, with `academicYear:"2026-2027"`, or with `superDreamMultiplier` < `dreamMultiplier` → 400 VALIDATION naming the field.
  - A valid `POST` → a following `GET` returns it with `isActive:true`.
  - `GET /offers/policy` is never treated as an offer id.
- **O9:** With accepted 10, extended 15 and 20: `offerType` is `dream` and `super-dream`; `isDreamEligible` is true; `currentAcceptedPackage` 10; `dreamMultiplier` 1.5. The accepted offer itself has `currentAcceptedPackage:null`.
- **O10:** A recruiter can create offers only for its own drives' applications (others → 404) and cannot place or override (403).

**Training:**
- **T1:** An empty `schedule` → 400 VALIDATION; `capacity:0` → 400.
- **T2:** A student sees only audience-matching `upcoming`/`ongoing` programs. Each has `schedule[0].{date,time,venue}`, `enrolledCount`, `capacity`, a string `status` and `nextSession`. An unsorted schedule comes back sorted.
- **T3:**
  - register → 201 and `enrolledCount` 1;
  - again → 409 ALREADY_REGISTERED;
  - with capacity 1, two concurrent registrations by different students → one 201 and one 409 PROGRAM_FULL, and `enrolledCount` stays 1.
- **T4:** `GET /training/my` → `[{program:{_id, schedule:[…]}, completionStatus:"enrolled", attendance:[]}]`. The documents live in `training_enrollments` (model `TrainingEnrollment`).
- **T5:** A schedule `PATCH` and a cancel notify registered students (`training.updated`). `runSweep()` with a clock moves programs through `upcoming → ongoing → completed`.
- **T6:** Marking attendance twice with `present:true` is idempotent; `present:false` removes the entry.

**Stats:**
- **S1:** Seed 10 students (6 CSE, 4 IT). Offers: accepted 8, 12 and 20 (the 20 belongs to a student who also has an accepted 9); placed 10; one extended; one rejected.
  - `placedStudents:4`, `placedPercent:40`.
  - Packages over [8, 10, 12, 20]: avg 12.5, median 11, max 20.
  - `offersByStatus` and `byBranch` are correct.
  - `topCompanies` is ordered by `accepted`.

**Tools** (call the handlers directly with a `ctx`):
- **TL1:** `jobs_search_campus({eligibleOnly:true})` as a student returns only eligible drives, with ui panel `jobs.campus`.
  - `data.jobs[0]` has every first-named key that JOB-FEED's `campus_item` reads: `id`, `company.name`, `employmentType`, `salary`, `skills`, `description`, `minimumCgpa`, `applicationDeadline`, `createdAt`, `isEligible`, `eligibilityReasons`, `matchScore`, `matchedSkills` and `myApplication`.
  - The same call as a TPO returns ui `{panel:"tpo.drives", params:{query}}`.
- **TL2:** `drive_apply`.
  - The preview returns `args.job` as a 24-hex id plus a summary.
  - The preview for an ineligible drive throws NOT_ELIGIBLE.
  - The handler creates the application with `source:"agent"`.
  - `job:"SDE"` with two SDE drives → `{ambiguous:true, candidates.length:2}`.
- **TL3:** `applicants_list` as a recruiter → ui `company.applicants`, and only own drives resolve.
- **TL4:** `application_update_status` with `status:"offered"` is rejected by schema validation (enum), and the service path throws USE_OFFER_FLOW.
- **TL5:** `offer_respond({decision:"accept"})` with exactly one extended offer → accepted.
- **TL6:** The `placement_stats` summary contains `% placed`.
- **TL7:** The `announce` preview counts only the CSE 2027 students.
- **TL8:** `drive_create` as a recruiter → status `pending`, and the summary mentions approval.

**Interviews** (`backend/test/interviews.test.js`):
- **I1:** `GET /interviews/my` returns only the caller's interviews, each with `rawReport` and `candidateName`, as an array.
- **I2:** `GET /interviews/:id` for another user's interview → 404; a malformed id → 400.
- **I3:** A teacher calling `/my` → 403.

---

## 17. Suggested build order
1. Pure helpers and their unit tests (§2). `utils/branch.js` comes from AUTH-FACULTY. If it is not merged yet, create it exactly as AUTH-FACULTY §6.3 specifies.
2. Models, the User additions and the migration.
3. The eligibility service.
4. The drive service and the jobs routes, plus the websocket adapter (AI1, J*).
5. Applications.
6. Policy and offers, plus the sync between them.
7. Training.
8. Stats, announcements and recruiters.
9. Events and the sweep.
10. Tools.
11. Interviews.
12. The frontend required edits (§14, items 1–7).
13. The new panels.
